import * as assert from 'assert';

// Compares whether two primitives, objects or arrays are the same or
// have the same properties. Property values are compared with `===`.
function shallowEquals(xs, ys) {
    if (xs === ys) {
        return true;
    }
    if (xs instanceof Array && ys instanceof Array) {
        if (xs.length !== ys.length) {
            return false;
        }
        for (let i = 0; i < xs.length; i++) {
            if (xs[i] !== ys[i]) {
                return false;
            }
        }
        return true;
    }
    // TODO(dpc): Implement shallow object comparison.
    throw Error('shallow object compare not implemented');
}

function kindOf(node: any) {
    if (node instanceof Array ||
        typeof node === 'number' ||
        typeof node === 'string' ||
        typeof node === 'boolean' ||
        typeof node === 'undefined') {
        // TODO(dpc): Make up some built-in kinds for these.
    }
    return node.constructor.name;
}

// Walks an AST and recovers a grammar from it.
export class GrammarRecoverer {
    // The grammar is just a node kind -> untyped list of properties.
    rules: Map<string, string[]>

    constructor() {
        this.rules = new Map();
    }

    /**
     * Visits `node`, checks and records its structure.
     */
    visit(node: any) {
        if (node instanceof Array) {
            // This is not very JavaScript-y because it doesn't handle
            // array-like objects. But all our arrays are arrays.
            for (let child of node) {
                this.visit(child);
            }
        } else if (node instanceof Object) {
            let kind = kindOf(node);
            if (!kind) {
                throw Error(`expected a typed AST node, got ${JSON.stringify(node).substring(0, 100)}`);
            }
            if (typeof kind !== 'string') {
                throw Error(`node type tags should be strings, got ${kind}`);
            }
            let props = Object.getOwnPropertyNames(node).filter((name) => name !== 'type').sort();

            let expected = this.rules[kind];
            if (expected && !shallowEquals(props, expected)) {
                throw Error(`encountered differing shapes of of ${kind}: ${expected} verus ${props}`);
            } else {
                this.rules[kind] = props;
            }
            for (let prop of props) {
                this.visit(node[prop]);
            }
        } else {
            if (node !== null &&
                typeof node !== 'number' &&
                typeof node !== 'boolean' &&
                typeof node !== 'undefined' &&
                typeof node !== 'string') {
                throw Error(`expected a primitive; got ${node}`);
            }
        }
    }
}
