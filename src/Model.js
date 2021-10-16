/*
    Model.js - DynamoDB model class

    A model represents a DynamoDB single-table entity.
*/
import {Expression} from './Expression.js'

/*
    Ready / write tags for interceptions
 */
const ReadWrite = {
    delete: 'write',
    get: 'read',
    find: 'read',
    put: 'write',
    scan: 'read',
    update: 'write'
}

const KeysOnly = { delete: true, get: true }
const TransactOps = { delete: 'Delete', get: 'Get', put: 'Put', update: 'Update' }
const BatchOps = { delete: 'DeleteRequest', put: 'PutRequest', update: 'PutRequest' }
const ValidTypes = ['array', 'binary', 'boolean', 'buffer', 'date', 'number', 'object', 'set', 'string' ]
const SanityPages = 1000
const FollowThreads = 10

export class Model {

    /*
        @param table Instance of Table.
        @param name Name of the model.
        @param options Hash of options.
     */
    constructor(table, name, options = {}) {
        if (!table) {
            throw new Error('Missing table argument')
        }
        if (!table.typeField || !table.uuid) {
            throw new Error('Invalid table instance')
        }
        if (!name) {
            throw new Error('Missing name of model')
        }
        this.table = table
        this.name = name
        this.options = options

        let schema = this.schema = (options.schema || (table.schema ? table.schema.schema : null))

        //  Primary hash and sort attributes and properties
        this.hash = null
        this.sort = null

        //  Cache table properties
        this.createdField = table.createdField
        this.delimiter = options.delimiter || table.delimiter
        this.generic = options.generic
        this.nested = false
        this.nulls = table.nulls
        this.tableName = table.name
        this.typeField = options.typeField || table.typeField
        this.timestamps = options.timestamps
        this.generic = options.generic != null ? options.generic : table.generic
        if (this.timestamps == null) {
            this.timestamps = table.timestamps
        }
        this.updatedField = table.updatedField
        this.indexes = options.indexes || (schema ? schema.indexes : null)

        if (!this.indexes) {
            throw new Error('Indexes must be defined before creating models')
        }
        this.indexProperties = this.getIndexProperties(this.indexes)
        this.block = {fields: {}, deps: []}

        /*
            Map Javascript API properties to DynamoDB attribute names. The schema fields
            map property may contain a '.' like 'obj.prop' to pack multiple properties into a single attribute.

            field.attribute = [attributeName, optional-sub-propertiy]
        */
        this.mappings = {}

        let fields = options.fields || (schema ? schema.models[this.name] : null)
        if (fields) {
            this.prepModel(fields, this.block)
        }
    }

    /*
        Prepare a model based on the schema and compute the attribute mapping.
     */
    prepModel(schemaFields, block, prefix = '') {
        let {fields} = block

        schemaFields = this.table.merge({}, schemaFields)
        if (!prefix) {
            //  Top level only
            if (!schemaFields[this.typeField]) {
                schemaFields[this.typeField] = { type: String, hidden: true }
                if (!this.generic) {
                    schemaFields[this.typeField].required = true
                }
            }
            if (this.timestamps) {
                schemaFields[this.createdField] = schemaFields[this.createdField] || { type: Date }
                schemaFields[this.updatedField] = schemaFields[this.updatedField] || { type: Date }
            }
        }
        let {indexes, table} = this
        let primary = indexes.primary

        //  Attributes that are mapped to a different attribute. Indexed by attribute name for this block.
        let mapTargets = {}
        let map = {}

        for (let [name, field] of Object.entries(schemaFields)) {
            let pathname = prefix ? `${prefix}.${name}` : name

            if (!field.type) {
                throw new Error(`Missing field type for ${pathname}`)
            }
            field.pathname = pathname
            field.name = name
            fields[name] = field

            field.type = this.checkType(field)

            /*
                Handle mapped attributes. May be packed also (obj.prop)
            */
            let to = field.map
            if (to) {
                let [att, sub] = to.split('.')
                mapTargets[att] = mapTargets[att] || []
                if (sub) {
                    if (map[name] && !Array.isArray(map[name])) {
                        throw new Error(`dynamo: Map already defined as literal for ${this.name}.${name}`)
                    }
                    field.attribute = map[name] = [att, sub]
                    if (mapTargets[att].indexOf(sub) >= 0) {
                        throw new Error(`Multiple attributes in ${this.pathname} mapped to the target ${to}`)
                    }
                    mapTargets[att].push(sub)
                } else {
                    if (mapTargets[att].length > 1) {
                        throw new Error(`Multiple attributes in ${this.name} mapped to the target ${to}`)
                    }
                    field.attribute = map[name] = [att]
                    mapTargets[att].push(true)
                }
            } else {
                field.attribute = map[name] = [name]
            }
            if (field.nulls !== true && field.nulls !== false) {
                field.nulls = this.nulls
            }

            /*
                Handle index requirements
            */
            let index = this.indexProperties[field.attribute[0]]
            if (index && !prefix) {
                field.isIndexed = true
                if (field.attribute.length > 1) {
                    throw new Error(`dynamo: Cannot map property "${pathname}" to a compound attribute "${this.name}.${pathname}"`)
                }
                if (index == 'primary') {
                    field.required = true
                    let attribute = field.attribute[0]
                    if (attribute == primary.hash) {
                        this.hash = attribute
                    } else if (attribute == primary.sort) {
                        this.sort = attribute
                    }
                }
            }
            if (field.value) {
                //  Value template properties are hidden by default
                if (field.hidden == null) {
                    field.hidden = table.hidden != null ? table.hidden : true
                }
            }
            /*
                Handle nested schema (recursive)
            */
            if (field.type == 'object' && field.schema) {
                field.block = {deps: [], fields: {}}
                this.prepModel(field.schema, field.block, name)
                this.nested = true
            }
        }
        if (Object.values(fields).find(f => f.unique && f.attribute != this.hash && f.attribute != this.sort)) {
            this.hasUniqueFields = true
        }
        this.mappings = mapTargets

        /*
            Order the fields so value templates can depend on each other safely
        */
        for (let field of Object.values(fields)) {
            this.orderFields(block, field)
        }
    }

    checkType(field) {
        let type = field.type
        if (typeof type == 'function') {
            type = type.name
        }
        type = type.toLowerCase()
        if (ValidTypes.indexOf(type) < 0) {
            throw new Error(`Unknown type "${type}" for field "${field.name}" in model "${this.name}"`)
        }
        return type
    }

    orderFields(block, field) {
        let {deps, fields} = block
        if (deps.find(i => i.name == field.pathname)) {
            return
        }
        if (field.value) {
            let vars = this.table.getVars(field.value)
            for (let pathname of vars) {
                let name = pathname.split('.').shift()
                let ref = fields[name]
                if (ref && ref != field && (ref.schema || ref.value)) {
                    this.orderFields(ref.block, ref)
                }
            }
        }
        deps.push(field)
    }

    getPropValue(properties, path) {
        let v = properties
        for (let part of path.split('.')) {
            v = v[part]
        }
        return v
    }

    /*
        Run an operation on DynamodDB. The command has been parsed via Expression.
        Returns [] for find/scan, cmd if !execute, else returns item.
     */
    async run(op, expression) {
        let {index, properties, params} = expression

        if (params.preFormat) {
            params.preFormat(this, expression)
        }

        /*
            Get a string representation of the API request
         */
        let cmd = expression.command()
        if (!expression.execute) {
            return cmd
        }
        /*
            Transactions save the command in params.transaction and wait for db.transaction() to be called.
         */
        let t = params.transaction
        if (t) {
            if (params.batch) {
                throw new Error('Cannot have batched transactions')
            }
            let top = TransactOps[op]
            if (top) {
                params.expression = expression
                let items = t.TransactItems = t.TransactItems || []
                items.push({[top]: cmd})
                return this.transformReadItem(op, properties, properties, params)
            } else {
                throw new Error(`Unknown transaction operation ${op}`)
            }
        }
        /*
            Batch operations save the command in params.transaction and wait for db.batchGet|batchWrite to be called.
         */
        let b = params.batch
        if (b) {
            params.expression = expression
            let items = b.RequestItems = b.RequestItems || {}
            if (op == 'get') {
                let list = items[this.tableName] = items[this.tableName] || {Keys: []}
                list.Keys.push(cmd.Keys)
                return this.transformReadItem(op, properties, properties, params)
            } else {
                let list = items[this.tableName] = items[this.tableName] || []
                let bop = BatchOps[op]
                list.push({[bop]: cmd})
                return this.transformReadItem(op, properties, properties, params)
            }
        }
        /*
            Prep the stats
        */
        let stats = params.stats
        if (stats && typeof params == 'object') {
            stats.count = stats.count || 0
            stats.scanned = stats.capacity || 0
            stats.capacity = stats.capacity || 0
        }

        /*
            Run command. Paginate if required.
         */
        let pages = 0, items = []
        let maxPages = params.maxPages ? params.maxPages : SanityPages
        let result
        do {
            result = await this.table.execute(this.name, op, cmd, params, properties)

            if (result.LastEvaluatedKey) {
                //  Continue next page
                cmd.ExclusiveStartKey = result.LastEvaluatedKey
            }
            if (result.Items) {
                items = items.concat(result.Items)
                if (stats) {
                    stats.count += result.Count
                    stats.scanned += result.ScannedCount
                    if (result.ConsumedCapacity) {
                        stats.capacity += result.ConsumedCapacity.CapacityUnits
                    }
                }
            } else if (result.Item) {
                items = [result.Item]
                break
            } else if (result.Attributes) {
                items = [result.Attributes]
                break
            }
            if (items.length) {
                if (cmd.Limit) {
                    cmd.Limit -= result.ScannedCount
                    if (cmd.Limit <= 0) {
                        break
                    }
                }
            }
        } while (result.LastEvaluatedKey && (maxPages == null || ++pages < maxPages))

        let prev
        if ((op == 'find' || op == 'scan') && items.length) {
            let {hash, sort} = index
            prev = { [hash]: items[0][hash], [sort]: items[0][sort]}
            if (prev[hash] == null || prev[sort] == null) {
                prev = null
            }
        }

        /*
            Process the response
        */
        if (params.parse) {
            items = this.parseResponse(op, expression, items)
        }

        /*
            Handle transparent follow. Get/Update/Find the actual item using the keys
            returned from the request on the GSI.
        */
        if (params.follow || (index.follow && params.follow !== false)) {
            if (op == 'get') {
                return await this.get(items[0])
            }
            if (op == 'update') {
                properties = Object.assign({}, properties, items[0])
                return await this.update(properties)
            }
            if (op == 'find') {
                let results = [], promises = []
                params = Object.assign({}, params)
                delete params.follow
                delete params.index
                delete params.fallback
                for (let item of items) {
                    promises.push(this.get(item, params))
                    if (promises.length > FollowThreads) {
                        results = results.concat(await Promise.all(promises))
                        promises = []
                    }
                }
                if (promises.length) {
                    results = results.concat(await Promise.all(promises))
                }
                return results
            }
        }

        /*
            Log unless the user provides params.log: false.
            The logger will typically filter data/trace.
        */
        if (params.log !== false) {
            this.table.log[params.log ? 'info' : 'data'](`OneTable result for "${op}" "${this.name}"`, {
                cmd, items, op, properties, params,
            })
        }

        /*
            Handle pagination next/prev
        */
        if (op == 'find' || op == 'scan') {
            if (result.LastEvaluatedKey) {
                //  DEPRECATE items.start in 2.0
                items.start = items.next = this.table.unmarshall(result.LastEvaluatedKey)
                Object.defineProperty(items, 'next', {enumerable: false})
            }
            if (params.count || params.select == 'COUNT') {
                items.count = result.Count
                Object.defineProperty(items, 'count', {enumerable: false})
            }
            if (prev) {
                items.prev = this.table.unmarshall(prev)
                Object.defineProperty(items, 'prev', {enumerable: false})
            }
            if (params.prev && op != 'scan') {
                //  DynamoDB scan ignores ScanIndexForward
                items = items.reverse()
                let tmp = items.prev ; items.prev = items.next ; items.next = tmp
            }
            return items
        }
        return items[0]
    }

    /*
        Parse the response into Javascript objects and transform for the high level API.
     */
    parseResponse(op, expression, items) {
        let {params, properties} = expression
        let {schema, table} = this
        if (op == 'put') {
            //  Put requests do not return the item. So use the properties.
            items = [properties]
        } else {
            items = table.unmarshall(items)
        }
        for (let [index, item] of Object.entries(items)) {
            if (params.high && params.index == this.indexes.primary && item[this.typeField] != this.name) {
                //  High level API on the primary index and item for a different model
                continue
            }
            let type = item[this.typeField] ? item[this.typeField] : this.name
            let model = schema.models[type] ? schema.models[type] : this
            if (model) {
                if (model == schema.uniqueModel) {
                    //  Special "unique" model for unique fields. Don't return in result.
                    continue
                }
                items[index] = model.transformReadItem(op, item, properties, params)
            }
        }
        return items
    }

    /*
        Create/Put a new item. Will overwrite existing items if exists: null.
    */
    async create(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {parse: true, high: true, exists: false}))
        let result
        if (this.hasUniqueFields) {
            result = await this.createUnique(properties, params)
        } else {
            result = await this.putItem(properties, params)
        }
        return result
    }

    /*
        Create an item with unique attributes. Use a transaction to create a unique item for each
        unique attribute.
     */
    async createUnique(properties, params) {
        if (params.batch) {
            throw new Error('Cannot use batch with unique properties which require transactions')
        }
        let transactHere = params.transaction ? false : true
        let transaction = params.transaction = params.transaction || {}
        let {hash, sort} = this.indexes.primary
        let fields = this.block.fields

        fields = Object.values(fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort)

        params.prepared = properties = this.prepareProperties('put', properties, params)

        for (let field of fields) {
            //  LEGACY - remove in 2.0 and just use the delimiter
            let sep = this.table.params.legacyUnique
            let pk
            if (sep) {
                pk = `${this.name}${sep}${field.attribute}${sep}${properties[field.name]}`
            } else {
                sep = this.delimiter
                pk = `_unique${sep}${this.name}${sep}${field.attribute}${sep}${properties[field.name]}`
            }
            await this.schema.uniqueModel.create({pk}, {transaction, exists: false, return: 'NONE'})
        }
        let item = await this.putItem(properties, params)

        if (!transactHere) {
            return item
        }
        let expression = params.expression
        try {
            await this.table.transact('write', params.transaction, params)
        } catch (err) {
            if (err.message.indexOf('ConditionalCheckFailed') >= 0) {
                throw new Error(`dynamo: Cannot create "${this.name}", an item of the same name already exists.`)
            }
        }
        let items = this.parseResponse('put', expression)
        return items[0]
    }

    async find(properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {parse: true, high: true}))
        return await this.queryItems(properties, params)
    }

    async get(properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {parse: true, high: true}))
        properties = this.prepareProperties('get', properties, params)
        if (params.fallback) {
            //  Fallback via find when using non-primary indexes
            params.limit = 2
            let items = await this.find(properties, params)
            if (items.length > 1) {
                throw new Error('Get without sort key returns more than one result')
            }
            return items[0]
        }
        //  FUTURE refactor to use getItem
        let expression = new Expression(this, 'get', properties, params)
        return await this.run('get', expression)
    }

    init(properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {parse: true, high: true}))
        return this.initItem(properties, params)
    }

    async remove(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {exists: null, high: true}))

        properties = this.prepareProperties('delete', properties, params)
        if (params.fallback) {
            return await this.removeByFind(properties, params)
        }
        let expression = new Expression(this, 'delete', properties, params)
        if (this.hasUniqueFields) {
            await this.removeUnique(properties, params)
        } else {
            await this.run('delete', expression)
        }
    }

    /*
        Remove multiple objects after doing a full find/query
     */
    async removeByFind(properties, params) {
        if (params.retry) {
            throw new Error('dynamo: Remove cannot retry')
        }
        params.parse = true
        let items = await this.find(properties, params)
        if (items.length > 1 && !params.many) {
            throw new Error(`dynamo: warning: removing multiple items from "${this.name}". Use many:true to enable.`)
        }
        for (let item of items) {
            if (this.hasUniqueFields) {
                await this.removeUnique(item, {retry: true})
            } else {
                await this.remove(item, {retry: true})
            }
        }
    }

    /*
        Remove an item with unique properties. Use transactions to remove unique items.
    */
    async removeUnique(properties, params) {
        let transaction = params.transaction = params.transaction || {}
        let {hash, sort} = this.indexes.primary
        let fields = Object.values(this.block.fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort)

        params.prepared = properties = this.prepareProperties('delete', properties, params)

        for (let field of fields) {
            //  LEGACY - remove in 2.0 and just use the delimiter
            let sep = this.table.params.legacyUnique
            let pk
            if (sep) {
                pk = `${this.name}${sep}${field.attribute}${sep}${properties[field.name]}`
            } else {
                sep = this.delimiter
                pk = `_unique${sep}${this.name}${sep}${field.attribute}${sep}${properties[field.name]}`
            }
            await this.schema.uniqueModel.remove({pk}, {transaction})
        }
        await this.deleteItem(properties, params)
        await this.table.transact('write', params.transaction, params)
    }

    async scan(properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {parse: true, high: true}))
        return await this.scanItems(properties, params)
    }

    async update(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params, {exists: true, parse: true, high: true}))
        if (this.hasUniqueFields) {
            let hasUniqueProperties = Object.entries(properties).find((pair, index) => {
                return this.block.fields[pair[0]].unique
            })
            if (hasUniqueProperties) {
                return await this.updateUnique(properties, params)
            }
        }
        return await this.updateItem(properties, params)
    }

    /*
        Update an item with unique attributes and actually updating a unique property.
        Use a transaction to update a unique item for each unique attribute.
     */
    async updateUnique(properties, params) {
        if (params.batch) {
            throw new Error('Cannot use batch with unique properties which require transactions')
        }
        let transactHere = params.transaction ? false : true
        let transaction = params.transaction = params.transaction || {}
        let {hash, sort} = this.indexes.primary

        params.prepared = properties = this.prepareProperties('update', properties, params)

        /*
            Get the prior item so we know the previous unique property values so they can be removed.
            This must be run here, even if part of a transaction.
        */
        let prior = await this.get(properties)
        if (prior) {
            prior = this.prepareProperties('update', prior)
        } else if (params.exists === undefined || params.exists == true) {
            throw new Error('Cannot find item to update')
        }

        /*
            Create all required unique properties. Remove prior unique properties if they have changed.
        */
        let fields = Object.values(this.block.fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort)

        for (let field of fields) {
            if (properties[field.name] === undefined) {
                continue
            }
            //  LEGACY - remove in 2.0 and just use the delimiter
            let pk
            let sep = this.table.params.legacyUnique
            if (sep) {
                pk = `${this.name}${sep}${field.attribute}${sep}${properties[field.name]}`
            } else {
                let sep = this.delimiter
                pk = `_unique${sep}${this.name}${sep}${field.attribute}${sep}${properties[field.name]}`
            }
            if (prior && prior[field.name]) {
                //  LEGACY - remove in 2.0 and just use the delimiter
                let priorPk
                if (sep) {
                    priorPk = `${this.name}${sep}${field.attribute}${sep}${prior[field.name]}`
                } else {
                    let sep = this.delimiter
                    priorPk = `_unique${sep}${this.name}${sep}${field.attribute}${sep}${prior[field.name]}`
                }
                /*
                    Remove prior unique properties if they have changed and create new unique property.
                */
                if (pk == priorPk) {
                    //  Hasn't changed
                    continue
                }
                await this.schema.uniqueModel.remove({pk: priorPk}, {transaction, exists: null})
            }
            await this.schema.uniqueModel.create({pk}, {transaction, exists: false, return: 'NONE'})
        }

        let item = await this.updateItem(properties, params)

        if (!transactHere) {
            return item
        }

        /*
            Perform all operations in a transaction so update will only be applied if the unique properties can be created.
        */
        let expression = params.expression
        try {
            await this.table.transact('write', params.transaction, params)
        } catch (err) {
            if (err.message.indexOf('ConditionalCheckFailed') >= 0) {
                throw new Error(`dynamo: Cannot create "${this.name}", an item of the same name already exists.`)
            }
        }
        let items = this.parseResponse('put', expression)
        return items[0]
    }

    //  Low level API

    /* private */
    async deleteItem(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        if (!params.prepared) {
            properties = this.prepareProperties('delete', properties, params)
        }
        let expression = new Expression(this, 'delete', properties, params)
        await this.run('delete', expression)
    }

    /* private */
    async getItem(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        properties = this.prepareProperties('get', properties, params)
        let expression = new Expression(this, 'get', properties, params)
        return await this.run('get', expression)
    }

    /* private */
    initItem(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        return this.setDefaults('init', this.block.fields, properties)
    }

    /* private */
    async putItem(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        if (this.timestamps) {
            properties[this.updatedField] = properties[this.createdField] = new Date()
        }
        if (!params.prepared) {
            properties = this.prepareProperties('put', properties, params)
        }
        let expression = new Expression(this, 'put', properties, params)
        return await this.run('put', expression)
    }

    /* private */
    async queryItems(properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        properties = this.prepareProperties('find', properties, params)
        let expression = new Expression(this, 'find', properties, params)
        return await this.run('find', expression)
    }

    //  Note: scanItems will return all model types
    /* private */
    async scanItems(properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        properties = this.prepareProperties('scan', properties, params)
        let expression = new Expression(this, 'scan', properties, params)
        return await this.run('scan', expression)
    }

    /* private */
    async updateItem(properties, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        if (this.timestamps) {
            properties[this.updatedField] = new Date()
        }
        properties = this.prepareProperties('update', properties, params)
        let expression = new Expression(this, 'update', properties, params)
        return await this.run('update', expression)
    }

    /* private */
    async fetch(models, properties = {}, params = {}) {
        ({params, properties} = this.checkArgs(properties, params))
        if (models.length == 0) {
            return {}
        }
        let where = []
        for (let model of models) {
            where.push(`\${${this.typeField}} = {${model}}`)
        }
        if (params.where) {
            params.where = `(${params.where}) and (${where.join(' or ')})`
        } else {
            params.where = where.join(' or ')
        }
        params.parse = true
        params.hidden = true

        let items = await this.queryItems(properties, params)
        return this.table.groupByType(items)
    }

    /*
        Map Dynamo types to Javascript types after reading data
     */
    transformReadItem(op, raw, properties, params) {
        if (!raw) {
            return raw
        }
        let rec = {}
        let fields = this.block.fields

        for (let [name, field] of Object.entries(fields)) {
            //  Skip hidden params. Follow needs hidden params to do the follow.
            if (field.hidden && params.hidden !== true && params.follow !== true) {
                continue
            }
            let att, sub
            if (op == 'put') {
                att = field.name
            } else {
                [att, sub] = field.attribute
            }
            let value = raw[att]
            if (value == undefined) {
                continue
            }
            if (sub) {
                value = value[sub]
            }
            if (field.crypt && params.decrypt !== false) {
                value = this.decrypt(value)
            }
            if (field.default !== undefined && value === undefined) {
                //  DEPRECATED
                if (typeof field.default == 'function') {
                    value = field.default(this, field.name, properties)
                } else {
                    value = field.default
                }

            } else if (value === undefined) {
                if (field.required) {
                    this.table.log.error(`Required field "${name}" in model "${this.name}" not defined in table item`, {
                        model: this.name, raw, params, field
                    })
                }
                continue

            } else {
                rec[name] = this.transformReadAttribute(field, name, value, params)
            }
        }
        if (this.generic) {
            //  Generic must include attributes outside the schema.
            for (let [name, value] of Object.entries(raw)) {
                if (rec[name] === undefined) {
                    rec[name] = value
                }
            }
        }
        if (params.hidden == true && rec[this.typeField] === undefined) {
            rec[this.typeField] = this.name
        }
        if (this.table.transform && ReadWrite[op] == 'read') {
            rec = this.table.transform(this, op, rec, params, raw)
        }
        return rec
    }

    transformReadAttribute(field, name, value, params) {
        if (typeof params.transform == 'function') {
            //  Invoke custom data transform after reading
            return params.transform(this, 'read', name, value)
        }
        //  DEPRECATED
        if (typeof field.transform == 'function') {
            //  Invoke custom data transform after reading
            return field.transform(this, 'read', name, value)
        }
        if (field.type == 'date') {
            return value ? new Date(value) : null
        }
        if (field.type == 'buffer' || field.type == 'binary') {
            return Buffer.from(value, 'base64')
        }
        return value
    }

    /*
        Validate properties and map types before writing to the database.
        Note: this does not map names to attributes or evaluate value templates, that happens in Expression.
     */
    prepareProperties(op, properties, params = {}) {
        let index = this.selectIndex(op, params)
        if (index != this.indexes.primary) {
            //  Handle fallback for get/delete as GSIs only support find and scan
            if (op != 'find' && op != 'scan') {
                if (params.low) {
                    throw new Error('Cannot use non-primary index for "${op}" operation')
                }
                params.fallback = true
                return properties
            }
        }
        let rec = this.transformProperties(op, this.block, index, properties, params)

        if (op != 'scan' && this.getHash(rec, this.block.fields, index, params) == null) {
            this.table.log.error(`Empty hash key`, {properties, params, op})
            throw new Error(`dynamo: Empty hash key. Check hash key and any value template variable references.`)
        }
        if (this.table.transform && ReadWrite[op] == 'write') {
            rec = this.table.transform(this, op, rec, params)
        }
        return rec
    }

    /*
        Return the hash property name for the selected index.
    */
    getHash(rec, fields, index, params) {
        let generic = params.generic != null ? params.generic : this.generic
        if (generic) {
            return rec[index.hash]
        }
        let field = Object.values(fields).find(f => f.attribute[0] == index.hash)
        if (!field) {
            return null
        }
        return rec[field.name]
    }

    /*
        Get the index for the request
    */
    selectIndex(op, params) {
        let index
        if (params.index && params.index != 'primary') {
            index = this.indexes[params.index]
            if (!index) {
                throw new Error(`Cannot find index ${params.index}`)
            }
        } else {
            index = this.indexes.primary
        }
        return index
    }

    transformProperties(op, block, index, properties, params, context, rec = {}) {
        let fields = block.fields
        if (!context) {
            context = params.context ? params.context : this.table.context
        }
        this.tunnelProperties(properties, params)
        this.addContext(op, fields, index, properties, params, context)
        this.setDefaults(op, fields, properties)
        this.runTemplates(op, index, fields, properties, params)
        this.convertNulls(fields, properties, params)

        this.validateProperties(op, fields, properties)

        //  Process nested schema
        if (this.nested && !KeysOnly[op]) {
            for (let [name, value] of Object.entries(properties)) {
                let field = fields[name]
                if (field && field.schema && typeof value == 'object') {
                    let r = rec[name] = rec[name] || {}
                    this.transformProperties(op, field.block, index, value, params, context[name] || {}, r)
                }
            }
        }
        return this.selectProperties(op, block, index, properties, params, rec)
    }

    /*
        For typescript, we cant use properties: {name: [between], name: {begins}}
        so tunnel from the params. Works for between, begins, < <= = >= >
    */
    tunnelProperties(properties, params) {
        if (params.tunnel) {
            for (let [kind, settings] of Object.entries(params.tunnel)) {
                for (let [key, value] of Object.entries(settings)) {
                    properties[key] = {[kind]: value}
                }
            }
        }
    }

    /*
        Select the properties to include in the request
    */
    selectProperties(op, block, index, properties, params, rec) {
        let project = index.project
        if (project) {
            if (project == 'all') {
                project = null
            } else if (project == 'keys') {
                let primary = this.indexes.primary
                project = [primary.hash, primary.sort, index.hash, index.sort]
            }
        }
        /*
            Unique valute templates may need other properties when removing unique items
        */
        for (let [name, field] of Object.entries(block.fields)) {
            if (field.schema) continue
            let attribute = field.attribute[0]
            let value = properties[name]
            if (block == this.block) {
                //  Missing sort key on a high-level API for get/delete
                if (value == null && attribute == index.sort && params.high && KeysOnly[op]) {
                    if (op == 'delete' && !params.many) {
                        throw new Error('Missing sort key')
                    }
                    /*
                        Missing sort key for high level get, or delete without many. Fallback to find to select the items of interest.
                        Get will throw if more than one result is returned.
                    */
                    params.fallback = true
                    return properties
                }
                if (KeysOnly[op] && attribute != index.hash && attribute != index.sort && !this.hasUniqueFields) {
                    //  Keys only for get and delete. Must include unique properties and all properties if unique value templates.
                    //  FUTURE: could have a "strict" mode where we warn for other properties instead of ignoring.
                    continue
                }
                if (project && project.indexOf(attribute) < 0) {
                    //  Attribute is not projected
                    continue
                }
                if (name == this.typeField && op == 'find') {
                    continue
                }
            }
            if (value !== undefined) {
                rec[name] = this.transformWriteAttribute(op, field, value, params)
            }
        }

        //  For generic (table low level APIs), add all properties that are projected
        let generic = params.generic != null ? params.generic : this.generic
        if (generic && !KeysOnly[op]) {
            for (let [name, value] of Object.entries(properties)) {
                if (project && project.indexOf(name) < 0) {
                    continue
                }
                if (rec[name] === undefined) {
                    //  Cannot do all type transformations - don't have enough info without fields
                    if (value instanceof Date) {
                        if (this.table.isoDates) {
                            rec[name] = value.toISOString()
                        } else {
                            rec[name] = value.getTime()
                        }
                    } else {
                        rec[name] = value
                    }
                }
            }
        }
        return rec
    }

    /*
        Add context to properties. If 'put', then for all fields, otherwise just key fields.
        Context overrides properties.
     */
    addContext(op, fields, index, properties, params, context) {
        for (let field of Object.values(fields)) {
            if (op == 'put' || (field.attribute[0] != index.hash && field.attribute[0] != index.sort)) {
                if (context[field.name] !== undefined) {
                    properties[field.name] = context[field.name]
                }
            }
        }
        if (!this.generic) {
            properties[this.typeField] = this.name
        }
    }

    /*
        Set default property values on Put.
    */
    setDefaults(op, fields, properties) {
        if (op != 'put' && op != 'init') return
        for (let field of Object.values(fields)) {
            if (field.type == 'object' && field.schema) {
                properties[field.name] = properties[field.name] || {}
                this.setDefaults(op, field.block.fields, properties[field.name])
            } else {
                let value = properties[field.name]

                //  Set defaults and uuid fields
                if (value === undefined && !field.value) {
                    if (field.default != null) {
                        //  DEPRECATED
                        if (typeof field.default == 'function') {
                            value = field.default(this, field.name, properties)
                        } else {
                            value = field.default
                        }

                    } else if (op == 'init') {
                        if (!field.uuid) {
                            //  Set non-default, non-uuid properties to null
                            value = null
                        }

                    } else if (field.uuid) {
                        if (field.uuid === true) {
                            value = this.table.makeID()

                        } else if (field.uuid == 'uuid') {
                            value = this.table.uuid()

                        } else if (field.uuid == 'ulid') {
                            value = this.table.ulid()
                        }
                    }
                    if (value !== undefined) {
                        properties[field.name] = value
                    }
                }
            }
        }
        return properties
    }

    /*
        Remove null properties from the table unless Table.nulls == true
    */
    convertNulls(fields, properties, params) {
        for (let [name, value] of Object.entries(properties)) {
            let field = fields[name]
            if (!field) continue
            if (value === null && field.nulls !== true) {
                if (params.remove && !Array.isArray(params.remove)) {
                    params.remove = [params.remove]
                } else {
                    params.remove = params.remove || []
                }
                params.remove.push(field.pathname)
                delete properties[name]

            } else if (field.type == 'object' && typeof value == 'object') {
                properties[name] = this.removeNulls(field, value)
            }
        }
    }

    /*
        Process value templates and property values that are functions
     */
    runTemplates(op, index, fields, properties, params) {
        for (let [name, field] of Object.entries(fields)) {
            if (field.isIndexed && (op != 'put' && op != 'update') &&
                    field.attribute[0] != index.hash && field.attribute[0] != index.sort) {
                //  Ignore indexes not being used for this call
                continue
            }
            if (typeof properties[name] == 'function') {
                properties[name] = properties[name](field.pathname, properties)
            }
            if (properties[name] === undefined && field.value) {
                //  DEPRECATED
                if (typeof field.value == 'function') {
                    properties[name] = field.value(field.pathname, properties)
                } else {
                    let value = this.runTemplate(op, index, field, properties, params, field.value)
                    if (value != null) {
                        properties[name] = value
                    }
                }
            }
        }
    }

    /*
        Expand a value template by substituting ${variable} values from context and properties.
     */
    runTemplate(op, index, field, properties, params, value) {
        /*
            Replace property references in ${var}
            Support ${var:length:pad-character} which is useful for sorting.
        */
        value = value.replace(/\${(.*?)}/g, (match, varName) => {
            let [name, len, pad] = varName.split(':')
            let v = this.getPropValue(properties, name)
            if (v !== undefined) {
                if (v instanceof Date) {
                    v = this.transformWriteDate(v)
                }
                if (len) {
                    //  Add leading padding for sorting numerics
                    pad = pad || '0'
                    let s = v + ''
                    while (s.length < len) s = pad + s
                    v = s
                }
            } else {
                v = match
            }
            return v
        })

        /*
            Consider unresolved template variables. If field is the sort key and doing find,
            then use sort key prefix and begins_with, (provide no where clause).
         */
        if (value.indexOf('${') >= 0) {
            if (field.attribute[0] == index.sort) {
                if (op == 'find' && !params.where) {
                    //  Remove unresolved ${} references and retain a fixed leading prefix portion.
                    value = value.replace(/\${(.*?)}.*/g, '')
                    if (value) {
                        return {begins: value}
                    }
                }
            }
            /*
                Return undefined if any variables remain undefined. This is critical to stop updating
                templates which do not have all the required properties to complete.
            */
            return undefined
        }
        return value
    }

    validateProperties(op, fields, properties) {
        if (op != 'put' && op != 'update') {
            return
        }
        let details = {}
        for (let [name, value] of Object.entries(properties)) {
            let field = fields[name]
            if (!field) continue
            if (field.validate || field.enum) {
                value = this.validateProperty(field, value, details)
                properties[name] = value
            }
        }
        for (let field of Object.values(fields)) {
            if (op == 'put' && properties[field.name] == null && field.required) {
                details[field.name] = `Value not defined for required field "${field.name}"`
            }
        }
        if (Object.keys(details).length > 0) {
            this.table.log.error(`Validation error for "${this.name}"`, {model: this.name, properties, details})
            let err = new Error(`dynamo: Validation Error for "${this.name}"`)
            err.details = details
            throw err
        }
    }

    validateProperty(field, value, details) {
        let validate = field.validate
        let fieldName = field.name
        if (validate) {
            if (value === null) {
                if (field.required && field.value == null) {
                    details[fieldName] = `Value not defined for "${fieldName}"`
                }
            } else if (typeof validate == 'function') {
                //  DEPRECATE
                let error
                ({error, value} = validate(this, field, value))
                if (error) {
                    details[fieldName] = error
                }
            } else if (validate instanceof RegExp) {
                if (!validate.exec(value)) {
                    details[fieldName] = `Bad value "${value}" for "${fieldName}"`
                }
            } else {
                let pattern = validate.toString()
                if (pattern[0] == '/' && pattern.lastIndexOf('/') > 0) {
                    let parts = pattern.split('/')
                    let qualifiers = parts.pop()
                    let pat = parts.slice(1).join('/')
                    validate = new RegExp(pat, qualifiers)
                    if (!validate.exec(value)) {
                        details[fieldName] = `Bad value "${value}" for "${fieldName}"`
                    }
                } else {
                    if (!value.match(pattern)) {
                        details[fieldName] = `Bad value "${value}" for "${fieldName}"`
                    }
                }
            }
        }
        if (field.enum) {
            if (field.enum.indexOf(value) < 0) {
                details[fieldName] = `Bad value "${value}" for "${fieldName}"`
            }
        }
        return value
    }

    /*
        Transform types before writing data to Dynamo
     */
    transformWriteAttribute(op, field, value, params) {
        let type = field.type

        if (typeof params.transform == 'function') {
            value = params.transform(this, 'write', field.name, value)

        } else if (typeof field.transform == 'function') {
            //  DEPRECATED
            value = field.transform(this, 'write', field.name, value)

        } else if (value == null && field.nulls === true) {
            //  Keep the null

        } else if (op == 'find' && value != null && typeof value == 'object') {
            //  Find used {begins} and other operators
            value = this.transformNestedWriteFields(field, value)

        } else if (type == 'date') {
            value = this.transformWriteDate(value)

        } else if (type == 'number') {
            let num = Number(value)
            if (isNaN(num)) {
                throw new Error(`Invalid value "${value}" provided for field "${field.name}"`)
            }
            value = num

        } else if (type == 'boolean') {
            if (value == 'false' || value == 'null' || value == 'undefined') {
                value = false
            }
            value = Boolean(value)

        } else if (type == 'string') {
            if (value != null) {
                value = value.toString()
            }

        } else if (type == 'buffer' || type == 'binary') {
            if (value instanceof Buffer || value instanceof ArrayBuffer || value instanceof DataView) {
                value = value.toString('base64')
            }

        } else if (type == 'set' && Array.isArray(value)) {
            value = this.transformWriteSet(type, value)

        } else if (type == 'object' && (value != null && typeof value == 'object')) {
            value = this.transformNestedWriteFields(field, value)
        }

        if (field.crypt && value != null) {
            value = this.encrypt(value)
        }
        return value
    }

    transformNestedWriteFields(field, obj) {
        for (let [key, value] of Object.entries(obj)) {
            let type = field.type
            if (value instanceof Date) {
                obj[key] = this.transformWriteDate(value)

            } else if (value instanceof Buffer || value instanceof ArrayBuffer || value instanceof DataView) {
                value = value.toString('base64')

            } else if (Array.isArray(value) && (field.type == Set || type == Set)) {
                value = this.transformWriteSet(type, value)

            } else if (value == null && field.nulls !== true) {
                //  Skip nulls
                continue

            } else if (value != null && typeof value == 'object') {
                obj[key] = this.transformNestedWriteFields(field, value)
            }
        }
        return obj
    }

    transformWriteSet(type, value) {
        if (!Array.isArray(value)) {
            throw new Error('Set values must be arrays')
        }
        if (type == Set || type == 'Set') {
            let v = value.values().next().value
            if (typeof v == 'string') {
                value = value.map(v => v.toString())
            } else if (typeof v == 'number') {
                value = value.map(v => Number(v))
            } else if (v instanceof Buffer || v instanceof ArrayBuffer || v instanceof DataView) {
                value = value.map(v => v.toString('base64'))
            }
        } else {
            throw new Error('Unknown type')
        }
        return value
    }

    /*
        Handle dates. Supports epoch and ISO date transformations.
    */
    transformWriteDate(value) {
        if (this.table.isoDates) {
            if (value instanceof Date) {
                value = value.toISOString()
            } else if (typeof value == 'string') {
                value = (new Date(Date.parse(value))).toISOString()
            } else if (typeof value == 'number') {
                value = (new Date(value)).toISOString()
            }
        } else {
            //  Convert dates to unix epoch
            if (value instanceof Date) {
                value = value.getTime()
            } else if (typeof value == 'string') {
                value = (new Date(Date.parse(value))).getTime()
            }
        }
        return value
    }

    /*
        Get a hash of all the property names of the indexes. Keys are properties, values are index names.
        Primary takes precedence if property used in multiple indexes (LSIs)
     */
    getIndexProperties(indexes) {
        let properties = {}
        for (let [indexName, index] of Object.entries(indexes)) {
            for (let [type, pname] of Object.entries(index)) {
                if (type == 'hash' || type == 'sort') {
                    if (properties[pname] != 'primary') {
                        //  Let primary take precedence
                        properties[pname] = indexName
                    }
                }
            }
        }
        return properties
    }

    encrypt(text, name = 'primary', inCode = 'utf8', outCode = 'base64') {
        return this.table.encrypt(text, name, inCode, outCode)
    }

    decrypt(text, inCode = 'base64', outCode = 'utf8') {
        return this.table.decrypt(text, inCode, outCode)
    }

    /*
        Clone properties and params to callers objects are not polluted
    */
    checkArgs(properties, params, overrides = {}) {
        if (params.checked) {
            //  Only need to clone once
            return {params, properties}
        }
        if (!properties) {
            throw new Error('Missing properties')
        }
        if (typeof params != 'object') {
            throw new Error('Invalid type for params')
        }
        params = Object.assign(overrides, params)
        params.checked = true
        properties = Object.assign({}, properties)
        return {params, properties}
    }

    /*
        Handle nulls properly according to nulls preference.
    */
    removeNulls(field, obj) {
        let result
        if (obj !== null && typeof obj == 'object') {
            result = Array.isArray(obj) ? [] : {}
            for (let [key, value] of Object.entries(obj)) {
                if (value == null && field.nulls !== true) {
                    //  Match null and undefined
                    continue
                } else if (typeof value == 'object') {
                    result[key] = this.removeNulls(field, value)
                } else {
                    result[key] = value
                }
            }
        } else {
            result = obj
        }
        return result
    }

    /*  KEEP
    captureStack() {
        let limit = Error.stackTraceLimit
        Error.stackTraceLimit = 1

        let obj = {}
        let v8Handler = Error.prepareStackTrace
        Error.prepareStackTrace = function(obj, stack) { return stack }
        Error.captureStackTrace(obj, this.captureStack)

        let stack = obj.stack
        Error.prepareStackTrace = v8Handler
        Error.stackTraceLimit = limit

        let frame = stack[0]
        return `${frame.getFunctionName()}:${frame.getFileName()}:${frame.getLineNumber()}`
    } */
}
