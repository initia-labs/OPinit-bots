import { MsgCreateBridge, BridgeConfig, Duration, BatchInfo } from 'initia-l1'
import {
  getDB as getExecutorDB,
  initORM as initExecutorORM
} from '../../src/worker/bridgeExecutor/db'
import {
  getDB as getChallengerDB,
  initORM as initChallengerORM
} from '../../src/worker/challenger/db'
import { getDB as getBatchDB, initORM as initBatchORM } from '../../src/worker/batchSubmitter/db'
import { DataSource, EntityManager } from 'typeorm'
import {
  ExecutorOutputEntity,
  StateEntity,
  ExecutorWithdrawalTxEntity,
  ExecutorDepositTxEntity,
  ExecutorUnconfirmedTxEntity,
  ChallengerDepositTxEntity,
  ChallengerFinalizeDepositTxEntity,
  ChallengerFinalizeWithdrawalTxEntity,
  ChallengerOutputEntity,
  ChallengerWithdrawalTxEntity,
  ChallengedOutputEntity,
  RecordEntity,
  ChallengeEntity
} from '../../src/orm'
import { executorL1, challengerL1, outputSubmitterL1 } from './helper'

class Bridge {
  executorDB: DataSource
  challengerDB: DataSource
  batchDB: DataSource
  l1BlockHeight: number
  l2BlockHeight: number

  constructor(
    public submissionInterval: number,
    public finalizedTime: number
  ) {}

  async clearDB() {
    // remove and initialize
    await initExecutorORM()
    await initChallengerORM()
    await initBatchORM();

    [this.executorDB] = getExecutorDB();
    [this.challengerDB] = getChallengerDB();
    [this.batchDB] = getBatchDB()

    await this.executorDB.transaction(async (manager: EntityManager) => {
      await manager.getRepository(StateEntity).clear()
      await manager.getRepository(ExecutorWithdrawalTxEntity).clear()
      await manager.getRepository(ExecutorOutputEntity).clear()
      await manager.getRepository(ExecutorDepositTxEntity).clear()
      await manager.getRepository(ExecutorUnconfirmedTxEntity).clear()
    })

    await this.challengerDB.transaction(async (manager: EntityManager) => {
      await manager.getRepository(ChallengerDepositTxEntity).clear()
      await manager.getRepository(ChallengerFinalizeDepositTxEntity).clear()
      await manager.getRepository(ChallengerFinalizeWithdrawalTxEntity).clear()
      await manager.getRepository(ChallengerOutputEntity).clear()
      await manager.getRepository(ChallengerWithdrawalTxEntity).clear()
      await manager.getRepository(ChallengedOutputEntity).clear()
      await manager.getRepository(ChallengeEntity).clear()
    })

    await this.batchDB.transaction(async (manager: EntityManager) => {
      await manager.getRepository(RecordEntity).clear()
    })
  }

  MsgCreateBridge(
    submissionInterval: number,
    finalizedTime: number,
    metadata: string
  ) {
    const bridgeConfig = new BridgeConfig(
      challengerL1.key.accAddress,
      outputSubmitterL1.key.accAddress,
      new BatchInfo('submitter', 'chain'),
      Duration.fromString(submissionInterval.toString()),
      Duration.fromString(finalizedTime.toString()),
      new Date(),
      metadata
    )
    return new MsgCreateBridge(executorL1.key.accAddress, bridgeConfig)
  }

  async tx(metadata: string) {
    const l1Msgs = [
      this.MsgCreateBridge(
        this.submissionInterval,
        this.finalizedTime,
        metadata
      )
    ]

    return await executorL1.transaction(l1Msgs)
  }
}

export default Bridge
