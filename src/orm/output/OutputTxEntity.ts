import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('output_tx')
export default class OutputTxEntity {
  @PrimaryColumn('text')
  txHash: string

  @Column()
  @Index('output_tx_output_index_index')
  outputIndex: number

  @Column()
  processed: boolean
}
