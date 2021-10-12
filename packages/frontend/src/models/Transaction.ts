import { ethers } from 'ethers'
import { EventEmitter } from 'events'
import { L1_NETWORK } from 'src/constants'
import { getRpcUrl, getProvider, getBaseExplorerUrl, networkSlugToId } from 'src/utils'

import { Hop, Token } from '@hop-protocol/sdk'
import { network as defaultNetwork } from 'src/config'
import { getTransferSentDetailsFromLogs } from 'src/utils/logs'
import logger from 'src/logger'
import { fetchTransfersFromL1Completeds, L1Transfer } from '../utils/queries'

interface Config {
  networkName: string
  destNetworkName?: string | null
  destTxHash?: string | null
  hash: string
  pending?: boolean
  timestamp?: number
  token?: Token
  isCanonicalTransfer?: boolean
  pendingDestinationConfirmation?: boolean
  transferId?: string | null
}

const standardNetworks = new Set(['mainnet', 'ropsten', 'kovan', 'rinkeby', 'goerli'])

class Transaction extends EventEmitter {
  readonly hash: string
  readonly networkName: string
  readonly destNetworkName: string | null = null
  readonly isCanonicalTransfer: boolean = false
  readonly provider: ethers.providers.Provider
  token: Token | null = null
  pending: boolean
  timestamp: number
  status: null | boolean = null
  pendingDestinationConfirmation?: boolean
  transferId: string | null = null
  destTxHash: string | null = null

  constructor({
    hash,
    networkName,
    destNetworkName,
    pending = true,
    timestamp,
    token,
    isCanonicalTransfer,
    pendingDestinationConfirmation = true,
    transferId,
  }: Config) {
    super()
    this.hash = (hash || '').trim().toLowerCase()
    this.networkName = (networkName || defaultNetwork).trim().toLowerCase()
    let rpcUrl = ''
    if (networkName.startsWith('arbitrum')) {
      rpcUrl = getRpcUrl('arbitrum')
    } else if (networkName.startsWith('optimism')) {
      rpcUrl = getRpcUrl('optimism')
    } else if (networkName.startsWith('xdai')) {
      rpcUrl = getRpcUrl('xdai')
    } else if (networkName.startsWith('matic') || networkName.startsWith('polygon')) {
      rpcUrl = getRpcUrl('polygon')
    } else {
      rpcUrl = getRpcUrl(L1_NETWORK)
    }
    if (destNetworkName) {
      this.destNetworkName = destNetworkName
      this.pendingDestinationConfirmation = pendingDestinationConfirmation
    }

    this.provider = getProvider(rpcUrl)
    this.timestamp = timestamp || Date.now()
    if (token) {
      this.token = token
    }
    this.pending = pending
    if (transferId) {
      this.transferId = transferId
    }

    this.receipt().then((receipt: any) => {
      const tsDetails = getTransferSentDetailsFromLogs(receipt.logs)

      // Source: L2
      if (tsDetails?.transferId) {
        this.transferId = tsDetails.transferId
      }

      this.status = !!receipt.status
      this.pending = false
      this.emit('pending', false, this)
    })
    if (typeof isCanonicalTransfer === 'boolean') {
      this.isCanonicalTransfer = isCanonicalTransfer
    }
    console.debug('transaction:', this.hash)
  }

  get explorerLink(): string {
    if (this.networkName.startsWith('ethereum')) {
      return this._etherscanLink()
    } else if (this.networkName.startsWith('arbitrum')) {
      return this._arbitrumLink()
    } else if (this.networkName.startsWith('optimism')) {
      return this._optimismLink()
    } else if (this.networkName.startsWith('xdai')) {
      return this._xdaiLink()
    } else if (this.networkName.startsWith('polygon')) {
      return this._polygonLink()
    } else {
      return ''
    }
  }

  get destExplorerLink(): string {
    if (!this.destTxHash) return ''

    if (this.destNetworkName?.startsWith('ethereum')) {
      return this._etherscanLink('ethereum', this.destTxHash)
    } else if (this.destNetworkName?.startsWith('arbitrum')) {
      return this._arbitrumLink(this.destTxHash)
    } else if (this.destNetworkName?.startsWith('optimism')) {
      return this._optimismLink(this.destTxHash)
    } else if (this.destNetworkName?.startsWith('xdai')) {
      return this._xdaiLink(this.destTxHash)
    } else if (this.destNetworkName?.startsWith('polygon')) {
      return this._polygonLink(this.destTxHash)
    } else {
      return ''
    }
  }

  get truncatedHash(): string {
    return `${this.hash.substring(0, 6)}…${this.hash.substring(62, 66)}`
  }

  async receipt() {
    return this.provider.waitForTransaction(this.hash)
  }

  async getTransaction() {
    return this.provider.getTransaction(this.hash)
  }

  async checkIsTransferIdSpent(sdk: Hop) {
    if (this.token && this.destNetworkName) {
      const receipt = await this.receipt()
      const tsDetails = getTransferSentDetailsFromLogs(receipt.logs)
      const bridge = sdk.bridge(this.token.symbol)

      // No transferId because L1 -> L2
      if (tsDetails && !tsDetails.transferId) {
        const l1Bridge = await bridge.getL1Bridge(this.provider)
        const decodedData = l1Bridge.interface.decodeEventLog(
          tsDetails?.eventName!,
          tsDetails?.log.data
        )

        if ('amount' in decodedData) {
          const { amount } = decodedData
          const transferFromL1Completeds = await fetchTransfersFromL1Completeds(
            this.destNetworkName,
            tsDetails.recipient,
            amount.toString()
          )

          if (transferFromL1Completeds.length) {
            const lastTransfer: L1Transfer =
              transferFromL1Completeds[transferFromL1Completeds.length - 1]

            this.destTxHash = lastTransfer.transactionHash
            this.pendingDestinationConfirmation = false
            return true
          }
        }
      }

      // transferId found in event: TransferSent
      if (this.transferId) {
        const destL2Bridge = await bridge.getL2Bridge(this.destNetworkName)
        const isSpent = await destL2Bridge.isTransferIdSpent(this.transferId)
        if (isSpent) {
          this.pendingDestinationConfirmation = false
        }
        logger.debug(`isSpent ${this.transferId}:`, isSpent)
        return isSpent
      }
    }

    return false
  }

  private _etherscanLink(networkName: string = this.networkName, txHash: string = this.hash) {
    return `${getBaseExplorerUrl(networkName)}/tx/${txHash}`
  }

  private _arbitrumLink(txHash: string = this.hash) {
    return `${getBaseExplorerUrl('arbitrum')}/tx/${txHash}`
  }

  private _optimismLink(txHash: string = this.hash) {
    try {
      const url = new URL(getBaseExplorerUrl('optimism'))
      return `${url.origin}${url.pathname}/tx/${txHash}${url.search}`
    } catch (err) {
      return ''
    }
  }

  private _xdaiLink(txHash: string = this.hash) {
    return `${getBaseExplorerUrl('xdai')}/tx/${txHash}`
  }

  private _polygonLink(txHash: string = this.hash) {
    return `${getBaseExplorerUrl('polygon')}/tx/${txHash}`
  }

  toObject() {
    const {
      hash,
      networkName,
      pending,
      timestamp,
      token,
      destNetworkName,
      isCanonicalTransfer,
      pendingDestinationConfirmation,
      transferId,
    } = this
    return {
      hash,
      networkName,
      pending,
      timestamp,
      token,
      destNetworkName,
      isCanonicalTransfer,
      pendingDestinationConfirmation,
      transferId,
    }
  }

  static fromObject(obj: any) {
    const {
      hash,
      networkName,
      pending,
      timestamp,
      token,
      destNetworkName,
      isCanonicalTransfer,
      pendingDestinationConfirmation,
      transferId,
    } = obj
    return new Transaction({
      hash,
      networkName,
      pending,
      timestamp,
      token,
      destNetworkName,
      isCanonicalTransfer,
      pendingDestinationConfirmation,
      transferId,
    })
  }
}

export default Transaction
