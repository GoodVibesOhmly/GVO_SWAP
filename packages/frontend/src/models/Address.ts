import { utils } from 'ethers'

export type Addressish = Address | string | undefined

class Address {
  private _address: string

  constructor (address: Addressish) {
    let _address
    if (address instanceof Address) {
      _address = address.toString()
    } else if (typeof address === 'string') {
      _address = utils.getAddress(address)
    }

    if (!_address || !utils.isAddress(_address)) {
      throw new Error('Invalid address')
    }

    this._address = _address
  }

  static from (address: Addressish): Address {
    return new Address(address)
  }

  toString (): string {
    return this._address
  }

  truncate (): string {
    return this._address.slice(0, 6) + '...' + this._address.slice(38, 42)
  }

  toLowercase (): string {
    return this._address.toLowerCase()
  }

  eq (address: Addressish): boolean {
    return new Address(address).toLowercase() === this.toLowercase()
  }
}

export default Address
