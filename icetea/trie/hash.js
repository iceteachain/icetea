/*
An implementation of https://ethresear.ch/t/a-nearly-trivial-on-zero-inputs-32-bytes-long-collision-resistant-hash-function/5511
*/

const { createHash } = require('crypto')

const HASH_ALGO = 'sha256'
const HASH_SIZE = 32 // 32 bytes = 256 bits

const zeroHash = (size = HASH_SIZE) => Buffer.alloc(size)

const naiveHash = buf => createHash(HASH_ALGO).update(buf).digest()

// left shift for one bit
const leftShiftOne = (buf, lastBit) => {
  lastBit = lastBit === 1 ? 1 : 0
  const last = buf.length - 1
  for (let i = last; i >= 0; i--) {
    const ubyte = buf.readUInt8(i)
    const shifted = ((ubyte << 1) & 0xff) + lastBit
    buf.writeUInt8(shifted, i)

    // after shifted, the first bit of this byte is dropped
    // so remember it to set to last bit of next byte
    lastBit = ubyte > 0x7f ? 1 : 0
  }

  return buf
}

// right shift for one bit
const rightShiftOne = (buf, destBuf, destOffset) => {
  let mask = 0
  const n = buf.length
  for (let i = 0; i < n; i++) {
    const ubyte = buf.readUInt8(i)
    const shifted = (ubyte >> 1) | mask
    destBuf.writeUInt8(shifted, i + destOffset)

    // save the last bit to set to first bit of next byte
    mask = (ubyte & 1) * 0x80
  }

  return buf
}

const isAllZero = buf => {
  for (const b of buf) {
    if (b !== 0) return false
  }

  return true
}

const canShortcut = (l, r, leftIs0, rightIs0) => {
  // If both hashes are non-zero, cannot shortcut
  if (!leftIs0 && !rightIs0) return false

  // reach here mean either left or right must be zero, but not both
  // (case both are zero checked by caller)

  const nonZero = leftIs0 ? r : l

  // if nonZero < 2 ** 240 || nonZero >= 2 ** 255, cannot shortcut
  const uint16 = nonZero.readUInt16BE(0)
  if (uint16 === 0 || uint16 > 0x7fff) return false

  // one side zero and the other size in range
  return true
}

const hash = (l, r) => {
  const leftIs0 = isAllZero(l)
  const rightIs0 = isAllZero(r)

  if (leftIs0 && rightIs0) {
    return {
      hash: zeroHash(),
      shortcut: true
    }
  }

  if (canShortcut(l, r, leftIs0, rightIs0)) {
    // right is non-zero then last bit is 1
    // left is non-zero then last bit is 0
    const [nonZeroBuf, lastBit] = leftIs0 ? [r, 1] : [l, 0]
    return {
      hash: leftShiftOne(nonZeroBuf, lastBit),
      shortcut: true
    }
  } else {
    const content = Buffer.concat([l, r], HASH_SIZE * 2)
    const hash = naiveHash(content)
    // clear the first 15 bit and set 16th bit to 1
    hash.writeUInt16BE(1, 0)
    return {
      hash,
      content,
      shortcut: false
    }
  }
}

// split a parent hash to left and right hash, if possible
// it return undefined if cannot dehash
// input: a buffer
// output: a buffer of 64 bytes (32 for left, next 32 for right)
const dehash = hash => {
  if (!hash || isAllZero(hash)) {
    // return zeroHash(HASH_SIZE * 2)
    return 0
  }

  // check if this is a shortcut
  // a shortcut has one of 15 first bits to be 1
  const first16BitsAsUint = hash.readUInt16BE(0)
  if (first16BitsAsUint > 1) {
    // it is a shortcut, get the lastBit
    // to see if left or right is zero
    const lastBit = hash.readUInt8(HASH_SIZE - 1) & 1

    // shift right one bit

    const buf = zeroHash(HASH_SIZE * 2)
    rightShiftOne(hash, buf, lastBit * HASH_SIZE)

    return buf
  }
}

// module.exports = { hash, dehash }

// export all for testing
module.exports = {
  naiveHash,
  zeroHash,
  isAllZero,
  canShortcut,
  leftShiftOne,
  rightShiftOne,
  hash,
  dehash
}
