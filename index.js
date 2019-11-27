const deepCopy = require('deep-copy');

const DEFAULT_OPTIONS = {
    maxKeys: 2500,
    stdTTL: -1,
    checkperiod: 600,
    useClones: true,
    deleteOnExpire: true,
    rotateType: 'oldest',

    // "Private" options
    objectValueSize: 80,
    promiseValueSize: 80,
    arrayValueSize: 40,
    ttlScale: 1000
};

const ROTATE_TYPES = ['oldest', 'inactive', 'expiry'];

module.exports = class RotatingCache {
    constructor(options) {
        this.data = {};
        this.options = Object.assign({}, DEFAULT_OPTIONS, options);
        if (![...ROTATE_TYPES, 'none'].includes(this.options.rotateType)) {
            throw new Error(`Invalid rotation type specified: ${this.options.rotateType}`);
        }
        this.stats = {
            keys: 0,
            hits: 0,
            misses: 0,
            keySize: 0,
            valueSize: 0
        };
        this.checkTimeout = setTimeout(this._expire.bind(this), this.options.checkperiod * this.options.ttlScale);
    }

    set(key, value, ttl = null) {
        key = this._makeKey(key);

        if (this.data[key]) {
            this.del(key);
        }

        if (this.stats.keys + 1 > this.options.maxKeys) {
            let delKey;
            switch (this.options.rotateType) {
                case 'oldest':
                    delKey = Object.keys(this.data).sort((a, b) => this.data[b].added - this.data[a].added)[0];
                    break;
                case 'inactive':
                    delKey = Object.keys(this.data).sort((a, b) => this.data[b].lastAccess - this.data[a].lastAccess)[0];
                    break;
                case 'expiry':
                    delKey = Object.keys(this.data).sort((a, b) => {
                        return this.data[a].ttl === -1 ? Infinity : (this._getTTLDate(a) - this._getTTLDate(b))
                    })[0];
                    break;
                default:
                    throw new Error(`Cache limit of ${this.options.maxKeys} keys reached.`);
            }
            this.del(delKey);
        }

        const size = this._getValueSize(value);

        this.stats.keys += 1;
        this.stats.keySize += this._getKeySize(key);
        this.stats.valueSize += size;

        this.data[key] = {
            value,
            size,
            ttl: ttl !== null ? ttl : this.options.stdTTL,
            added: Date.now(),
            lastAccess: Date.now()
        };
    }

    mset(data) {
        if (this.stats.keys + data.length > this.options.maxKeys && !ROTATE_TYPES.includes(this.options.rotateType)) {
            throw new Error(`Cache limit of ${this.options.maxKeys} keys will be reached.`);
        }

        data.forEach(({ key, value, ttl }) => this.set(key, value, ttl));
    }

    get(key) {
        key = this._makeKey(key);
        if (this.data[key]) {
            this.stats.hits += 1;
            this.data[key].lastAccess = Date.now();
            return this.options.useClones ? deepCopy(this.data[key].value) : this.data[key].value;
        } else {
            this.stats.misses += 1;
        }
    }

    mget(keys) {
        return keys.reduce((o, k) => { o[k] = this.get(k); return o; }, {});
    }

    del(key) {
        key = this._makeKey(key);
        if (!this.data[key]) {
            return 0;
        }
        this.stats.keySize -= this._getKeySize(key);
        this.stats.valueSize -= this.data[key].size;
        this.stats.keys -= 1;
        delete this.data[key];
        return 1;
    }

    mdel(keys) {
        return keys.reduce((s, k) => s + this.del(k), 0);
    }

    ttl(key, ttl) {
        key = this._makeKey(key);
        if (!this.data[key]) {
            throw new Error(`The specified key '${key}' does not exist`);
        }
        if (ttl === 0) {
            this.del(key)
        } else {
            this.data[key].ttl = ttl;
        }
    }

    getTtl(key) {
        key = this._makeKey(key);
        if (!this.data[key]) {
            throw new Error(`The specified key '${key}' does not exist`);
        }
        return this.data[key].ttl;
    }

    keys() {
        return Object.keys(this.data);
    }

    hasKey(key) {
        return this.data[key] !== undefined;
    }

    stats() {
        return Object.assign({}, this.stats);
    }

    flushAll() {
        this.data = {};
        this.stats = {
            keys: 0,
            hits: 0,
            misses: 0,
            keySize: 0,
            valueSize: 0
        };
    }

    flushStats() {
        this.stats.hits = 0;
        this.stats.misses = 0;
    }

    close() {
        clearTimeout(this.checkTimeout);
    }

    _expire() {
        const now = Date.now();
        for (const key of Object.keys(this.data)) {
            const data = this.data[key];
            if (data.ttl > -1 && data.added + this._getTTLDate(key) < now) {
                this.del(key);
            }
        }
    }

    _getTTLDate(key) {
        return this.data[key].ttl * this.options.ttlScale;
    }

    _getValueSize(value) {
        if (value === null || value === undefined) {
            return 0;
        }

        if (Array.isArray(value)) {
            return this.options.arrayValueSize * value.length;
        }

        if (value.then && typeof (value.then) === 'function') {
            return this.options.promiseValueSize;
        }

        switch (typeof (value)) {
            case 'string':
                return value.length;
            case 'number':
            case 'boolean':
                return 8;
            case 'object':
                return Object.keys(value).length * this.options.objectValueSize;
            default:
                return 0;
        }
    }

    _makeKey(key) {
        return key.toString();
    }

    _getKeySize(key) {
        return key.toString().length;
    }
}