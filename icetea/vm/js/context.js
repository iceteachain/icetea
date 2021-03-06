/** @module */
const utils = require('../../helper/utils')
const invoker = require('../../invoker/contractinvoker')
const libraryinvoker = require('../../invoker/libraryinvoker')
const config = require('../../config')
const { isValidAddress } = require('../../helper/utils')
const { isContract } = require('../../state/statemanager')
const crypto = require('crypto')
const { ContractMode, TxOp } = require('@iceteachain/common')
const { ensureAddress } = require('../../syscon/alias')

const moduleUtils = Object.freeze(require('@iceteachain/utils/utils.js'))
const moduleCrypto = Object.freeze({

  // What hash algos available depends on OpenSSL
  // In the future, we might linit the number of hash algos supported
  // to a safe and frequently-used list only.

  createHash: crypto.createHash,
  getHashes: crypto.getHashes,
  timingSafeEqual: crypto.timingSafeEqual
})

function reload (name) {
  const mapping = {
    ';': moduleUtils,
    crypto: moduleCrypto,
    'create-hash': moduleCrypto.createHash
  }
  if (mapping[name]) {
    return mapping[name]
  }

  const lib = require(name)
  delete require.cache[require.resolve(name)]
  return lib
}

const _require = (name) => {
  const whitelist = config.whitelistModules
  const ok = whitelist.some(element => {
    return name === element || name.startsWith(`${element}/`)
  })
  if (!ok) {
    throw new Error(`require('${name}') is not supported. If you want to load a contract, use loadContract function instead.`)
  }

  return reload(name)
}

function _makeLoadContract (invokerTypes, srcContract, options) {
  return destContract => {
    return new Proxy({}, {
      get (obj, method) {
        const tx = { from: srcContract }
        if (!options.origin) {
          tx.origin = srcContract
        }
        const newOpts = { ...options, tx, ...tx }
        return _makeInvokableMethod(invokerTypes, destContract, method, newOpts)
      }
    })
  }
}

function _makeLoadLibrary (invokerTypes, srcContract, options) {
  return destContract => {
    return new Proxy({}, {
      get (obj, method) {
        const tx = { from: srcContract }
        if (!options.origin) {
          tx.origin = srcContract
        }
        const newOpts = { ...options, tx, ...tx }
        return _makeLibraryMethod(invokerTypes, destContract, method, newOpts)
      }
    })
  }
}

function _makeTransfer (transferMethod, srcContract, options) {
  return (to, value) => {
    transferMethod(to, value)
    if (!isContract(to)) {
      return
    }

    let invoked = {}
    if (options.tx && options.tx.invoked) {
      invoked = options.tx.invoked
    }
    const tx = { from: srcContract, to, value, payer: srcContract, _notransfer: true, invoked: { ...invoked, [to]: true } }
    const newOpts = { ...options, tx }
    if (!invoked[to]) { // prevent cycle onreceive
      return invoker.invokeUpdate(to, config.messages.onreceive, [], newOpts)
    }
  }
}

function _makeInvokableMethod (invokerTypes, destContract, method, options) {
  destContract = ensureAddress(destContract)

  return invokerTypes.reduce((obj, t) => {
    obj[t] = (...params) => {
      return invoker[t](destContract, method, params, options)
    }

    if (t === 'invokeUpdate') {
      obj.value = (val) => {
        const tx = { value: val, fee: 0, payer: options.from, to: destContract, from: options.from }
        const newOpts = { ...options, tx }
        return {
          [t] (...params) {
            return invoker[t](destContract, method, params, newOpts)
          }
        }
      }
    }

    return obj
  }, {})
}

function _makeLibraryMethod (invokerTypes, destContract, method, options) {
  destContract = ensureAddress(destContract)
  return invokerTypes.reduce((obj, t) => {
    obj[t] = (...params) => {
      return libraryinvoker[t](destContract, method, params, options)
    }

    // TBD: value method in loadLibrary

    return obj
  }, {})
}

function _makeDeployContract (tools, contractHelpers, address, options) {
  return (contractSrc, deployOptions = {}) => {
    const isBuf = Buffer.isBuffer(contractSrc)
    const srcBuffer = isBuf ? contractSrc : Buffer.from(contractSrc)
    const defMode = isBuf ? ContractMode.JS_WASM : ContractMode.JS_RAW
    let src
    const { mode = defMode, value = 0, params = [] } = deployOptions
    if (mode === ContractMode.JS_RAW) {
      src = srcBuffer.toString('base64')
    } else if (mode === ContractMode.JS_WASM) {
      src = srcBuffer
    } else {
      throw new Error(`deployContract with unsupported mode: ${mode}`)
    }
    const tx = {
      data: {
        op: TxOp.DEPLOY_CONTRACT,
        mode,
        params,
        src
      },
      from: address,
      signers: [address],
      payer: address,
      value: BigInt(value)
    }
    const contractState = invoker.prepareContract(tx)
    const newAddress = tools.deployContract(address, contractState)

    // NOTE: No call __on_received when deploying
    // Should transfer before call ondeploy
    if (tx.value > 0) {
      contractHelpers.transfer(newAddress, tx.value)
    }

    // must include tx into the options so that ondeploy can access tx.value, etc.
    invoker.invokeUpdate(newAddress, config.messages.ondeploy, tx.data.params, { ...options, tx })
    return newAddress
  }
}

function _getContractInfo (tools, address, errorMessage) {
  const {
    deployedBy,
    system,
    mode,
    src
  } = tools.getCode(address, errorMessage)
  return { deployedBy, system, mode, src }
}

/**
 * context for (with invoke type)
 * @function
 * @param {string} invokeType - invoke type
 * @param {string} contractAddress - contract address.
 * @param {string} methodName - method name.
 * @param {Array.<string|number>} methodParams - parameters.
 * @param {object} options - method option.
 * @returns {object} context
 */
exports.for = (invokeType, contractAddress, methodName, methodParams, options) => {
  const map = {
    transaction: exports.forTransaction,
    view: exports.forView,
    pure: exports.forPure
  }

  const fn = map[invokeType] ? map[invokeType] : exports.forMetadata
  return typeof fn === 'function' ? fn(contractAddress, methodName, methodParams, options) : fn
}

/**
 * context for transaction
 * @function
 * @param {string} address - contract address.
 * @param {string} fname - method name.
 * @param {Array.<string|number>} fparams - parameters.
 * @param {object} options - method option.
 * @returns {object} context
 */
exports.forTransaction = (contractAddress, methodName, methodParams, options) => {
  const { tx, block, stateAccess, tools, events } = options

  const msg = {}
  msg.name = methodName
  msg.params = methodParams
  msg.sender = tx.from
  msg.signers = tx.signers
  msg.value = tx.value
  msg.fee = tx.fee
  msg.callType = (msg.value > 0 && methodName !== '_beforePayFor') ? 'payable' : 'transaction'

  const contractHelpers = stateAccess.forUpdate(contractAddress)
  const { deployedBy } = tools.getCode(contractAddress)

  const ctx = {
    ...contractHelpers,
    transfer: _makeTransfer(contractHelpers.transfer, contractAddress, options),
    address: contractAddress,
    deployedBy,
    get balance () {
      return tools.balanceOf(contractAddress)
    },
    runtime: {
      msg,
      block: {
        hash: block.hash,
        number: block.number,
        timestamp: block.timestamp
      },
      balanceOf: tools.balanceOf,
      loadContract: _makeLoadContract(['invokeUpdate', 'invokeView', 'invokePure'], contractAddress, options),
      loadLibrary: _makeLoadLibrary(['invokeUpdate', 'invokeView', 'invokePure'], contractAddress, options),
      isValidAddress,
      getContractInfo: (addr, errorMessage) => _getContractInfo(tools, addr, errorMessage),
      require: _require,
      deployContract: _makeDeployContract(tools, contractHelpers, contractAddress, options)
    },
    emitEvent: (eventName, eventData, indexes = []) => {
      utils.emitEvent(contractAddress, events, eventName, eventData, indexes)
    }
  }

  return utils.deepFreeze(ctx) // prevent from changing address, balance, etc.
}

/**
 * context for view
 * @function
 * @param {string} address - contract address.
 * @param {string} name - method name.
 * @param {Array.<string|number>} params - parameters.
 * @param {object} option - method option.
 * @returns {object} context
 */
exports.forView = (contractAddress, name, params, options) => {
  const { from, block, stateAccess, tools } = options

  const msg = new Proxy({ name, params: utils.deepFreeze(params), sender: from, callType: 'view' }, {
    get (target, prop) {
      if (Object.keys(msg).includes(prop) && !['name', 'params', 'callType', 'sender'].includes(prop)) {
        throw new Error('Cannot access msg.' + prop + ' when calling a view function')
      }
      return Reflect.get(target, prop)
    },
    set () {
      throw new Error('msg properties are readonly.')
    }
  })

  const contractHelpers = stateAccess.forView(contractAddress)
  const { deployedBy } = tools.getCode(contractAddress)

  const ctx = {
    ...contractHelpers,
    address: contractAddress,
    deployedBy,
    get balance () {
      return tools.balanceOf(contractAddress)
    },
    runtime: Object.freeze({
      msg,
      block: Object.freeze({
        hash: block.hash,
        number: block.number,
        timestamp: block.timestamp
      }),
      balanceOf: tools.balanceOf,
      loadContract: _makeLoadContract(['invokeView', 'invokePure'], contractAddress, options),
      loadLibrary: _makeLoadLibrary(['invokeView', 'invokePure'], contractAddress, options),
      isValidAddress,
      getContractInfo: (addr, errorMessage) => _getContractInfo(tools, addr, errorMessage),
      require: _require
    })
  }

  return Object.freeze(ctx)
}

/**
 * context for pure
 * @function
 * @param {string} address - contract address.
 * @param {string} name - method name.
 * @param {Array.<string|number>} params - parameters.
 * @param {object} option - method option.
 * @returns {object} context
 */
exports.forPure = (address, name, params, { from, block = {} }) => {
  const ctx = {
    address,
    runtime: {
      msg: {
        sender: from,
        name,
        params,
        callType: 'pure'
      },
      block: {
        hash: block.hash,
        number: block.number,
        timestamp: block.timestamp
      },
      isValidAddress,
      require: _require
    }
  }

  return utils.deepFreeze(ctx)
}

/**
 * metadata for unlisted invoke type
 */
exports.forMetadata = address => ({
  address,
  runtime: {
    msg: {
      callType: 'metadata',
      name: '__metadata'
    },
    block: {},
    require: _require,
    loadContract: () => ({}),
    loadLibrary: () => ({})
  }
})
