import { MsgProposeOutput } from 'initia-l1'
import { INTERVAL_OUTPUT } from '../../config'
import { ExecutorOutputEntity } from '../../orm'
import { delay } from 'bluebird'
import { outputLogger as logger } from '../../lib/logger'
import { ErrorTypes } from '../../lib/error'
import { config } from '../../config'
import { getLastOutputInfo } from '../../lib/query'
import MonitorHelper from '../../lib/monitor/helper'
import { DataSource, EntityManager } from 'typeorm'
import { getDB } from './db'
import {
  TxWalletL1,
  WalletType,
  getWallet,
  initWallet
} from '../../lib/walletL1'
import { updateOutputUsageMetrics } from '../../lib/metrics'

export class OutputSubmitter {
  private db: DataSource
  private submitter: TxWalletL1
  private syncedOutputIndex = 1
  private processedBlockNumber = 1
  private isRunning = false
  private bridgeId: number
  helper: MonitorHelper = new MonitorHelper()

  async init() {
    [this.db] = getDB()
    initWallet(WalletType.OutputSubmitter, config.l1lcd)
    this.submitter = getWallet(WalletType.OutputSubmitter)
    this.bridgeId = config.BRIDGE_ID
    this.isRunning = true
  }

  public async run() {
    await this.init()

    while (this.isRunning) {
      await this.processOutput()
      await delay(INTERVAL_OUTPUT)
      updateOutputUsageMetrics()
    }
  }

  async getOutput(
    manager: EntityManager
  ): Promise<ExecutorOutputEntity | null> {
    try {
      const lastOutputInfo = await getLastOutputInfo(this.bridgeId)
      if (lastOutputInfo) {
        this.syncedOutputIndex = lastOutputInfo.output_index + 1
      }

      const output = await this.helper.getOutputByIndex(
        manager,
        ExecutorOutputEntity,
        this.syncedOutputIndex
      )

      if (!output) return null

      return output
    } catch (err) {
      if (err.response?.data.type === ErrorTypes.NOT_FOUND_ERROR) {
        logger.warn(
          `waiting for output index from L1: ${this.syncedOutputIndex}, processed block number: ${this.processedBlockNumber}`
        )
        await delay(INTERVAL_OUTPUT)
        return null
      }
      throw err
    }
  }

  async processOutput() {
    await this.db.transaction(async (manager: EntityManager) => {
      const output = await this.getOutput(manager)
      if (!output) {
        logger.info(
          `waiting for output index from DB: ${this.syncedOutputIndex}, processed block number: ${this.processedBlockNumber}`
        )
        return
      }

      await this.proposeOutput(output)
      logger.info(
        `successfully submitted! output index: ${this.syncedOutputIndex}, output root: ${output.outputRoot} (${output.startBlockNumber}, ${output.endBlockNumber})`
      )
    })
  }

  public async stop() {
    this.isRunning = false
  }

  private async proposeOutput(outputEntity: ExecutorOutputEntity) {
    const msg = new MsgProposeOutput(
      this.submitter.key.accAddress,
      this.bridgeId,
      outputEntity.endBlockNumber,
      outputEntity.outputRoot
    )

    await this.submitter.transaction([msg], undefined, 1000 * 60 * 10) // 10 minutes

    this.processedBlockNumber = outputEntity.endBlockNumber
  }
}
