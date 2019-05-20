const { verifyTxSignature } = require('icetea-common/src/utils')
const utils = require('./helper/utils')
const sysContracts = require('./system')
const invoker = require('./contractinvoker')
const did = require('./system/did')
const { ecc, codec } = require('icetea-common')
const _ = require('lodash')

const stateManager = require('./statemanager')

function _ensureAddress (addr) {
  // resolve alias
  if (addr && addr.includes('.')) {
    return sysContracts.Alias.ensureAddress(addr)
  }

  return addr
}

class App {
  constructor () {
    // Copy some methods
    Object.assign(this, {
      setBlock: stateManager.setBlock.bind(stateManager),
      loadState: stateManager.load.bind(stateManager),
      persistState: stateManager.persist.bind(stateManager),
      balanceOf: stateManager.balanceOf.bind(stateManager),
      debugState: stateManager.debugState.bind(stateManager)
    })
  }

  async activate () {
    this.initSystemContracts()
    await stateManager.load()
    const lastState = await stateManager.getLastState()
    console.log('Last state loaded', { height: lastState.lastBlockHeight, appHash: lastState.lastBlockAppHash.toString('hex').toUpperCase() })
    return lastState
  }

  installSystemContracts () {
    sysContracts.all().forEach(key => {
      const state = stateManager.installSystemContract(key)
      const contract = sysContracts.get(key)
      if (typeof contract.ondeploy === 'function') {
        contract.ondeploy(state)
      }
    })
  }

  initSystemContracts () {
    sysContracts.all().forEach(key => {
      const contract = sysContracts.get(key)
      contract.systemContracts = () => sysContracts
      contract.unsafeStateManager = () => stateManager
    })
  }

  getContractAddresses (preferAlias) {
    const addreses = stateManager.getContractAddresses()
    if (!preferAlias || !addreses.length) return addreses

    const aliases = sysContracts.Alias.getAliases()
    const aliasKeys = Object.keys(aliases)
    if (!aliasKeys.length) return addreses

    const address2Alias = aliasKeys.reduce((prev, alias) => {
      const address = aliases[alias].address
      prev[address] = alias
      return prev
    }, {})

    return addreses.map(addr => (address2Alias.hasOwnProperty(addr) ? address2Alias[addr] : addr))
  }

  addStateObserver ({ beforeTx, afterTx }) {
    stateManager.on('beginCheckpoint', beforeTx)
    stateManager.on('endCheckpoint', afterTx)
  }

  checkTx (tx) {
    // CheckTX should not modify state
    // This way, we could avoid make a copy of state

    verifyTxSignature(tx)

    if (tx.payer) {
      tx.payer = _ensureAddress(tx.payer)
    }

    // verify TO to avoid lost fund
    if (tx.to) {
      tx.to = _ensureAddress(tx.to)
      if (tx.to.includes('.')) {
        if (!sysContracts.has(tx.to)) {
          throw new Error(`Invalid destination alias ${tx.to}`)
        }
      } else {
        const toType = ecc.validateAddress(tx.to).type
        if (tx.value > 0n && toType === codec.REGULAR_ACCOUNT) {
          throw new Error('Could not transfer to regular account.')
        }
      }
    } else {
      if (!tx.isContractCreation()) {
        throw new Error('Transaction destination address is required.')
      }
    }

    // ensure valid signers
    if (tx.signers.length === 0) {
      throw new Error('Must have at lease one signature.')
    } else if (tx.signers.length === 1) {
      if (tx.from === tx.signers[0]) {
        throw new Error("No need to set 'from' to save blockchain data size.") // so strict!
      }
    } else if (!tx.from) {
      throw new Error("Must explicitly set 'from' when there are more than 1 signer.")
    }

    tx.from = tx.from || tx.signers[0]
    const blockTimestamp = (stateManager.getBlock() || {}).timestamp || 0
    did.checkPermission(tx.from, tx.signers, blockTimestamp)

    // check payer
    if (!tx.payer) {
      if (tx.value + tx.fee > 0n && codec.isRegularAddress(tx.from)) {
        // This seems redundant since regular account should always have balance of 0
        throw new Error('Cannot transfer from a regular account without specifying a payer.')
      }
    } else {
      const { type: ptype } = ecc.validateAddress(tx.payer)
      if (ptype === codec.REGULAR_ACCOUNT) {
        throw new Error('Cannot specify a regular account as transaction payer.')
      }

      // check if the payer is a contract or an user
      // this only reference state, not modify => should be ok
      if (stateManager.isContract(tx.payer)) {
        let agree = false
        try {
          agree = this.invokeView(tx.payer, '_agreeToPayFor', _.cloneDeep(tx))
        } catch (err) {
          throw new Error('Payer throws exception: ' + (err.stack || String(err)))
        }

        if (!agree) {
          throw new Error('Payer does not agree to pay.')
        }
      } else {
        did.checkPermission(tx.payer, tx.signers, blockTimestamp)
      }
    }

    // Check balance
    if (tx.value + tx.fee > stateManager.balanceOf(tx.payer || tx.from)) {
      throw new Error('Not enough balance')
    }
  }

  invokeView (contractAddress, methodName, methodParams, options = {}) {
    // resolve alias
    contractAddress = _ensureAddress(contractAddress)

    const { stateAccess, tools } = stateManager.produceDraft()
    options.stateAccess = stateAccess
    options.tools = tools
    options.block = stateManager.getBlock()
    return invoker.invokeView(contractAddress, methodName, methodParams, options)
  }

  invokePure (contractAddress, methodName, methodParams, options = {}) {
    // resolve alias
    contractAddress = _ensureAddress(contractAddress)

    const { tools } = stateManager.produceDraft()
    options.tools = tools
    options.block = stateManager.getBlock()
    return invoker.invokePure(contractAddress, methodName, methodParams, options)
  }

  getMetadata (addr) {
    // resolve alias
    addr = _ensureAddress(addr)

    const { system, src, meta } = stateManager.getAccountState(addr)
    if (!src && !system) {
      throw new Error('Address is not a valid contract.')
    }

    if (meta && meta.operations) {
      return utils.unifyMetadata(meta.operations)
    }

    const info = invoker.queryMetadata(addr, stateManager.getMetaProxy(addr))
    if (!info) return utils.unifyMetadata()

    const props = info.meta ||
      (info.instance ? utils.getAllPropertyNames(info.instance) : info)

    return utils.unifyMetadata(props)
  }

  getAccountInfo (addr) {
    addr = _ensureAddress(addr)
    const { balance = 0, system, mode, src, deployedBy } = stateManager.getAccountState(addr)
    return { balance, system, mode, hasSrc: !!src, deployedBy }
  }

  execTx (tx) {
    this.checkTx(tx)

    // No need, already done inside checkTx above
    // tx.to = _ensureAddress(tx.to)

    stateManager.beginCheckpoint()

    const needState = willCallContract(tx)
    const { stateAccess, patch, tools } = needState ? stateManager.produceDraft() : {}

    const result = doExecTx({
      tx,
      block: stateManager.getBlock(),
      stateAccess,
      tools
    })

    // commit change made to state
    // if _doExecTx throws, this won't be called
    if (needState) {
      stateManager.applyDraft(patch)
    }

    stateManager.endCheckpoint()

    return result || []
  }
}

/**
 * validate tx op and tx.to source
 * @private
 * @function
 * @param {object} tx - transation
 * @return {boolean} is right to execute
 */
function willCallContract (tx) {
  return tx.isContractCreation() || tx.isContractCall() || (tx.value > 0 && stateManager.isContract(tx.to))
}

/**
 * execute tx logic
 * @private
 * @function
 * @param {object} options - options
 * @return {object} result
 */
function doExecTx (options) {
  const { tx, tools = {} } = options
  let result

  if (tx.isContractCreation()) {
    // analyze & save contract state
    const contractState = invoker.prepareContract(tx)
    tx.to = tools.deployContract(tx.from, contractState)
  }

  // process value transfer
  (tools.refectTxValueAndFee || stateManager.handleTransfer)(tx)

  if (tx.isContractCreation()) {
    // call constructor
    result = invoker.invokeUpdate(
      tx.to,
      '__on_deployed',
      tx.data.params,
      options
    )
    // Result of ondeploy should be address
    result[0] = tx.to
  } else if (tx.isContractCall()) {
    if (['constructor', '__on_received', '__on_deployed', 'getState', 'setState', 'getEnv'].includes(tx.data.name)) {
      throw new Error('Calling this method directly is not allowed')
    }
    result = invoker.invokeTx(options)
  }

  // call __on_received
  if (tx.value && stateManager.isRegularContract(tx.to) && !tx.isContractCreation() && !tx.isContractCall()) {
    result = invoker.invokeUpdate(tx.to, '__on_received', tx.data.params, options)
  }

  let returnValue = result
  // TODO: check it with wasm, do not know result in wasm is array or not, check later
  if (Array.isArray(returnValue) && returnValue.length > 0) {
    returnValue = returnValue[0]
  }
  if (returnValue && returnValue.__gas_used && tools.refectTxValueAndFee) {
    tools.refectTxValueAndFee({ from: tx.from, value: BigInt(0), fee: -(tx.fee - BigInt(returnValue.__gas_used)) })
    delete returnValue.__gas_used
  }

  // emit Transferred event
  if (tx.value > 0) {
    const emitTransferred = (tags) => {
      return utils.emitTransferred(null, tags, tx.from, tx.to, tx.value)
    }
    if (result) {
      emitTransferred(result[1])
    } else {
      result = [undefined, emitTransferred()]
    }
  }

  return result
}

module.exports = utils.newAndBind(App)
