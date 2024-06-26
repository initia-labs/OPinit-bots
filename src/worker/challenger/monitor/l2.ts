import {
  ChallengerFinalizeDepositTxEntity,
  ChallengerOutputEntity,
  ChallengerWithdrawalTxEntity
} from '../../../orm'
import { OutputInfo } from 'initia-l2'
import { Monitor } from '../../bridgeExecutor/monitor'
import { EntityManager } from 'typeorm'
import { RPCClient } from '../../../lib/rpc'
import winston from 'winston'
import { getDB } from '../db'
import { config } from '../../../config'
import { BOT_NAME } from '../../common/name'

export class L2Monitor extends Monitor {
  outputIndex: number
  outputInfo: OutputInfo
  startBlockNumber: number

  constructor(
    public rpcClient: RPCClient,
    logger: winston.Logger
  ) {
    super(rpcClient, logger);
    [this.db] = getDB()
    this.outputIndex = 0
  }

  public name(): string {
    return BOT_NAME.CHALLENGER_L2_MONITOR
  }

  private async handleInitiateTokenWithdrawalEvent(
    manager: EntityManager,
    data: { [key: string]: string }
  ): Promise<void> {
    const outputInfo = await this.helper.getLastOutputFromDB(
      manager,
      ChallengerOutputEntity
    )

    if (!outputInfo) return

    const pair = await config.l1lcd.ophost
      .tokenPairByL2Denom(this.bridgeId, data['denom'])
      .catch((e) => {
        const errMsg = this.helper.extractErrorMessage(e)
        this.logger.warn(`Failed to get token ${data['denom']} pair ${errMsg}`)
        return null
      })

    if (!pair) {
      this.logger.info(
        `[handleInitiateTokenWithdrawalEvent - ${this.name()}] No token pair for ${data['denom']}... skipping`
      )
      return
    }

    const tx: ChallengerWithdrawalTxEntity = {
      l1Denom: pair.l1_denom,
      l2Denom: pair.l2_denom,
      sequence: data['l2_sequence'],
      sender: data['from'],
      receiver: data['to'],
      amount: data['amount'],
      bridgeId: this.bridgeId.toString(),
      outputIndex: outputInfo ? outputInfo.outputIndex + 1 : 1,
      merkleRoot: '',
      merkleProof: []
    }

    await this.helper.saveEntity(manager, ChallengerWithdrawalTxEntity, tx)
  }

  public async handleFinalizeTokenDepositEvent(
    manager: EntityManager,
    data: { [key: string]: string }
  ): Promise<void> {
    const entity: ChallengerFinalizeDepositTxEntity = {
      sequence: data['l1_sequence'],
      sender: data['sender'],
      receiver: data['recipient'],
      l2Denom: data['denom'],
      amount: data['amount'],
      l1Height: parseInt(data['finalize_height'])
    }
    await manager.getRepository(ChallengerFinalizeDepositTxEntity).save(entity)
  }

  public async handleEvents(manager: EntityManager): Promise<boolean> {
    const blockResults = await this.getBlockResultsByHeight(this.currentHeight)
    const [isEmpty, events] = await this.helper.fetchAllEvents(blockResults)

    if (isEmpty) return false

    const withdrawalEvents = events.filter(
      (evt) => evt.type === 'initiate_token_withdrawal'
    )
    for (const evt of withdrawalEvents) {
      const attrMap = this.helper.eventsToAttrMap(evt)
      await this.handleInitiateTokenWithdrawalEvent(manager, attrMap)
    }

    const finalizeEvents = events.filter(
      (evt) => evt.type === 'finalize_token_deposit'
    )
    for (const evt of finalizeEvents) {
      const attrMap = this.helper.eventsToAttrMap(evt)
      await this.handleFinalizeTokenDepositEvent(manager, attrMap)
    }

    return true
  }
}
