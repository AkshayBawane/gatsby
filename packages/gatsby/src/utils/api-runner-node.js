const Promise = require(`bluebird`)
const glob = require(`glob`)
const _ = require(`lodash`)
const chalk = require(`chalk`)

const tracer = require(`opentracing`).globalTracer()
const reporter = require(`gatsby-cli/lib/reporter`)
const getCache = require(`./get-cache`)
const apiList = require(`./api-node-docs`)
const createNodeId = require(`./create-node-id`)
const createContentDigest = require(`./create-content-digest`)
const { getNonGatsbyCodeFrame } = require(`./stack-trace-utils`)

// Bind action creators per plugin so we can auto-add
// metadata to actions they create.
const boundPluginActionCreators = {}
const doubleBind = (boundActionCreators, api, plugin, actionOptions) => {
  const { traceId } = actionOptions
  if (boundPluginActionCreators[plugin.name + api + traceId]) {
    return boundPluginActionCreators[plugin.name + api + traceId]
  } else {
    const keys = Object.keys(boundActionCreators)
    const doubleBoundActionCreators = {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const boundActionCreator = boundActionCreators[key]
      if (typeof boundActionCreator === `function`) {
        doubleBoundActionCreators[key] = (...args) => {
          // Let action callers override who the plugin is. Shouldn't be
          // used that often.
          if (args.length === 1) {
            boundActionCreator(args[0], plugin, actionOptions)
          } else if (args.length === 2) {
            boundActionCreator(args[0], args[1], actionOptions)
          }
        }
      }
    }
    boundPluginActionCreators[
      plugin.name + api + traceId
    ] = doubleBoundActionCreators
    return doubleBoundActionCreators
  }
}

const initAPICallTracing = parentSpan => {
  const startSpan = (spanName, spanArgs = {}) => {
    const defaultSpanArgs = { childOf: parentSpan }

    return tracer.startSpan(spanName, _.merge(defaultSpanArgs, spanArgs))
  }

  return {
    tracer,
    parentSpan,
    startSpan,
  }
}

const runAPI = (plugin, api, args) => {
  const gatsbyNode = require(`${plugin.resolve}/gatsby-node`)
  if (gatsbyNode[api]) {
    const parentSpan = args && args.parentSpan
    const spanOptions = parentSpan ? { childOf: parentSpan } : {}
    const pluginSpan = tracer.startSpan(`run-plugin`, spanOptions)

    pluginSpan.setTag(`api`, api)
    pluginSpan.setTag(`plugin`, plugin.name)

    let pathPrefix = ``
    const { store, emitter } = require(`../redux`)
    const {
      loadNodeContent,
      getNodes,
      getNode,
      getNodesByType,
      hasNodeChanged,
      getNodeAndSavePathDependency,
    } = require(`../db/nodes`)
    const { boundActionCreators } = require(`../redux/actions`)

    const doubleBoundActionCreators = doubleBind(
      boundActionCreators,
      api,
      plugin,
      { ...args, parentSpan: pluginSpan }
    )

    if (store.getState().program.prefixPaths) {
      pathPrefix = store.getState().config.pathPrefix
    }

    const namespacedCreateNodeId = id => createNodeId(id, plugin.name)

    const tracing = initAPICallTracing(pluginSpan)

    const cache = getCache(plugin.name)

    // Ideally this would be more abstracted and applied to more situations, but right now
    // this can be potentially breaking so targeting `createPages` API and `createPage` action
    let apiFinished = false
    if (api === `createPages`) {
      let alreadyDisplayed = false
      const createPageAction = doubleBoundActionCreators.createPage
      doubleBoundActionCreators.createPage = (...args) => {
        createPageAction(...args)
        if (apiFinished && !alreadyDisplayed) {
          const warning = [
            reporter.stripIndent(`
              Action ${chalk.bold(
                `createPage`
              )} was called outside of its expected asynchronous lifecycle ${chalk.bold(
              `createPages`
            )} in ${chalk.bold(plugin.name)}.
              Ensure that you return a Promise from ${chalk.bold(
                `createPages`
              )} and are awaiting any asynchronous method invocations (like ${chalk.bold(
              `graphql`
            )} or http requests).
              For more info and debugging tips: see ${chalk.bold(
                `https://gatsby.app/sync-actions`
              )}
            `),
          ]

          const possiblyCodeFrame = getNonGatsbyCodeFrame()
          if (possiblyCodeFrame) {
            warning.push(possiblyCodeFrame)
          }

          reporter.warn(warning.join(`\n\n`))
          alreadyDisplayed = true
        }
      }
    }

    const apiCallArgs = [
      {
        ...args,
        pathPrefix,
        boundActionCreators: doubleBoundActionCreators,
        actions: doubleBoundActionCreators,
        loadNodeContent,
        store,
        emitter,
        getCache,
        getNodes,
        getNode,
        getNodesByType,
        hasNodeChanged,
        reporter,
        getNodeAndSavePathDependency,
        cache,
        createNodeId: namespacedCreateNodeId,
        createContentDigest,
        tracing,
      },
      plugin.pluginOptions,
    ]

    // If the plugin is using a callback use that otherwise
    // expect a Promise to be returned.
    if (gatsbyNode[api].length === 3) {
      return Promise.fromCallback(callback => {
        const cb = (err, val) => {
          pluginSpan.finish()
          callback(err, val)
          apiFinished = true
        }
        gatsbyNode[api](...apiCallArgs, cb)
      })
    } else {
      const result = gatsbyNode[api](...apiCallArgs)
      pluginSpan.finish()
      return Promise.resolve(result).then(res => {
        apiFinished = true
        return res
      })
    }
  }

  return null
}

let filteredPlugins
const hasAPIFile = plugin => glob.sync(`${plugin.resolve}/gatsby-node*`)[0]

let apisRunningById = new Map()
let apisRunningByTraceId = new Map()
let waitingForCasacadeToFinish = []

module.exports = async (api, args = {}, pluginSource) =>
  new Promise(resolve => {
    const { parentSpan } = args
    const apiSpanArgs = parentSpan ? { childOf: parentSpan } : {}
    const apiSpan = tracer.startSpan(`run-api`, apiSpanArgs)

    apiSpan.setTag(`api`, api)
    _.forEach(args.traceTags, (value, key) => {
      apiSpan.setTag(key, value)
    })

    // Check that the API is documented.
    // "FAKE_API_CALL" is used when code needs to trigger something
    // to happen once the the API queue is empty. Ideally of course
    // we'd have an API (returning a promise) for that. But this
    // works nicely in the meantime.
    if (!apiList[api] && api !== `FAKE_API_CALL`) {
      reporter.panic(`api: "${api}" is not a valid Gatsby api`)
    }

    const { store } = require(`../redux`)
    const plugins = store.getState().flattenedPlugins
    // Get the list of plugins that implement gatsby-node
    if (!filteredPlugins) {
      filteredPlugins = plugins.filter(plugin => hasAPIFile(plugin))
    }

    // Break infinite loops.
    // Sometimes a plugin will implement an API and call an
    // action which will trigger the same API being called.
    // "onCreatePage" is the only example right now.
    // In these cases, we should avoid calling the originating plugin
    // again.
    let noSourcePluginPlugins = filteredPlugins
    if (pluginSource) {
      noSourcePluginPlugins = filteredPlugins.filter(
        p => p.name !== pluginSource
      )
    }

    const apiRunInstance = {
      api,
      args,
      pluginSource,
      resolve,
      span: apiSpan,
      startTime: new Date().toJSON(),
      traceId: args.traceId,
    }

    // Generate IDs for api runs. Most IDs we generate from the args
    // but some API calls can have very large argument objects so we
    // have special ways of generating IDs for those to avoid stringifying
    // large objects.
    let id
    if (api === `setFieldsOnGraphQLNodeType`) {
      id = `${api}${apiRunInstance.startTime}${args.type.name}${args.traceId}`
    } else if (api === `onCreateNode`) {
      id = `${api}${apiRunInstance.startTime}${
        args.node.internal.contentDigest
      }${args.traceId}`
    } else if (api === `preprocessSource`) {
      id = `${api}${apiRunInstance.startTime}${args.filename}${args.traceId}`
    } else if (api === `onCreatePage`) {
      id = `${api}${apiRunInstance.startTime}${args.page.path}${args.traceId}`
    } else {
      // When tracing is turned on, the `args` object will have a
      // `parentSpan` field that can be quite large. So we omit it
      // before calling stringify
      const argsJson = JSON.stringify(_.omit(args, `parentSpan`))
      id = `${api}|${apiRunInstance.startTime}|${
        apiRunInstance.traceId
      }|${argsJson}`
    }
    apiRunInstance.id = id

    if (args.waitForCascadingActions) {
      waitingForCasacadeToFinish.push(apiRunInstance)
    }

    apisRunningById.set(apiRunInstance.id, apiRunInstance)
    if (apisRunningByTraceId.has(apiRunInstance.traceId)) {
      const currentCount = apisRunningByTraceId.get(apiRunInstance.traceId)
      apisRunningByTraceId.set(apiRunInstance.traceId, currentCount + 1)
    } else {
      apisRunningByTraceId.set(apiRunInstance.traceId, 1)
    }

    Promise.mapSeries(noSourcePluginPlugins, plugin => {
      let pluginName =
        plugin.name === `default-site-plugin`
          ? `gatsby-node.js`
          : `Plugin ${plugin.name}`

      return new Promise(resolve => {
        resolve(runAPI(plugin, api, { ...args, parentSpan: apiSpan }))
      }).catch(err => {
        reporter.panicOnBuild(`${pluginName} returned an error`, err)
        return null
      })
    }).then(results => {
      // Remove runner instance
      apisRunningById.delete(apiRunInstance.id)
      const currentCount = apisRunningByTraceId.get(apiRunInstance.traceId)
      apisRunningByTraceId.set(apiRunInstance.traceId, currentCount - 1)

      if (apisRunningById.size === 0) {
        const { emitter } = require(`../redux`)
        emitter.emit(`API_RUNNING_QUEUE_EMPTY`)
      }

      // Filter empty results
      apiRunInstance.results = results.filter(result => !_.isEmpty(result))

      // Filter out empty responses and return if the
      // api caller isn't waiting for cascading actions to finish.
      if (!args.waitForCascadingActions) {
        apiSpan.finish()
        resolve(apiRunInstance.results)
      }

      // Check if any of our waiters are done.
      waitingForCasacadeToFinish = waitingForCasacadeToFinish.filter(
        instance => {
          // If none of its trace IDs are running, it's done.
          const apisByTraceIdCount = apisRunningByTraceId.get(instance.traceId)
          if (apisByTraceIdCount === 0) {
            instance.span.finish()
            instance.resolve(instance.results)
            return false
          } else {
            return true
          }
        }
      )
      return
    })
  })
