import Bluebird from 'bluebird'
import { Block, BlockResults, RPCClient } from '../../../lib/rpc'
import { StateEntity } from '../../../orm'
import { DataSource, EntityManager } from 'typeorm'
import MonitorHelper from './helper'
import winston from 'winston'
import { INTERVAL_MONITOR, config } from '../../../config'
import { updateExecutorUsageMetrics } from '../../../lib/metrics'
import { BOT_NAME } from '../../common/name'

const MAX_BLOCKS = 20 // DO NOT CHANGE THIS, hard limit is 20 in cometbft.
const MAX_RETRY_INTERVAL = 30_000

export abstract class Monitor {
  public syncedHeight: number
  public currentHeight: number
  public latestHeight: number

  public isFirstRun = true

  protected db: DataSource
  protected isRunning = false
  protected bridgeId: number
  protected retryNum = 0
  helper: MonitorHelper = new MonitorHelper()

  constructor(
    public rpcClient: RPCClient,
    public logger: winston.Logger
  ) {
    this.bridgeId = config.BRIDGE_ID
  }

  public async getBlockByHeight(height: number): Promise<Block | null> {
    const res = await this.helper.feedBlock(this.rpcClient, height, height)
    return res[0][1]
  }

  public async getBlockResultsByHeight(height: number): Promise<BlockResults> {
    const res = await this.helper.feedBlockResults(
      this.rpcClient,
      height,
      height
    )
    return res[0][1]
  }

  public async run(): Promise<void> {
    const state = await this.db.getRepository(StateEntity).findOne({
      where: {
        name: this.name()
      }
    })

    this.syncedHeight = state?.height || 0

    if (!state) {
      if (this.name() === BOT_NAME.EXECUTOR_L1_MONITOR) {
        this.syncedHeight = config.EXECUTOR_L1_MONITOR_HEIGHT
      } else if (this.name() === BOT_NAME.EXECUTOR_L2_MONITOR) {
        this.syncedHeight = config.EXECUTOR_L2_MONITOR_HEIGHT
      } else if (this.name() === BOT_NAME.CHALLENGER_L1_MONITOR) {
        this.syncedHeight = config.CHALLENGER_L1_MONITOR_HEIGHT
      } else if (this.name() === BOT_NAME.CHALLENGER_L2_MONITOR) {
        this.syncedHeight = config.CHALLENGER_L2_MONITOR_HEIGHT
      }

      await this.db
        .getRepository(StateEntity)
        .save({ name: this.name(), height: this.syncedHeight })
    }

    this.isRunning = true
    await this.monitor()
  }

  public stop(): void {
    this.isRunning = false
  }

  async handleBlockWithStateUpdate(manager: EntityManager): Promise<void> {
    await this.handleBlock(manager)
    if (this.syncedHeight % 10 === 0) {
      this.logger.info(`${this.name()} syncedHeight ${this.syncedHeight}`)
    }
    this.syncedHeight++
    await manager
      .getRepository(StateEntity)
      .update({ name: this.name() }, { height: this.syncedHeight })
    await this.endBlock()
  }

  public async monitor(): Promise<void> {
    await this.prepareMonitor()
    while (this.isRunning) {
      try {
        this.latestHeight = await this.rpcClient.getLatestBlockHeight()
        if (!this.latestHeight || !(this.latestHeight > this.syncedHeight))
          continue

        // cap the query to fetch 20 blocks at maximum
        // DO NOT CHANGE THIS, hard limit is 20 in cometbft.
        const maxHeight = Math.min(
          this.latestHeight,
          this.syncedHeight + MAX_BLOCKS
        )

        const blockchainData = await this.rpcClient.getBlockchain(
          this.syncedHeight + 1,
          maxHeight
        )
        if (blockchainData === null) continue

        await this.handleNewBlock()

        await this.db.transaction(async (manager: EntityManager) => {
          for (const metadata of blockchainData.block_metas.reverse()) {
            this.currentHeight = this.syncedHeight + 1

            if (this.currentHeight !== parseInt(metadata.header.height)) {
              throw new Error(
                `expected block meta is the height ${this.currentHeight}, but got ${metadata.header.height}`
              )
            }
            if (parseInt(metadata.num_txs) === 0) {
              await this.handleBlockWithStateUpdate(manager)
              continue
            }

            // handle event always called when there is a tx in a block,
            // so empty means, the tx indexing is still on going.
            const ok: boolean = await this.handleEvents(manager)
            if (!ok) {
              this.retryNum++
              if (this.retryNum * INTERVAL_MONITOR >= MAX_RETRY_INTERVAL) {
                // rotate when tx index data is not found during 30s after block stored.
                this.rpcClient.rotateRPC()
              }
              break
            }
            this.retryNum = 0
            await this.handleBlockWithStateUpdate(manager)
          }
        })
      } finally {
        await Bluebird.delay(INTERVAL_MONITOR)
        updateExecutorUsageMetrics()
      }
    }
  }

  // eslint-disable-next-line
  public async handleEvents(manager: EntityManager): Promise<any> {}

  // eslint-disable-next-line
  public async handleBlock(manager: EntityManager): Promise<void> {}

  // eslint-disable-next-line
  public async handleNewBlock(): Promise<void> {}

  // eslint-disable-next-line
  public async endBlock(): Promise<void> {}

  // eslint-disable-next-line
  public async prepareMonitor(): Promise<void> {}

  // eslint-disable-next-line
  public name(): string {
    return ''
  }
}
