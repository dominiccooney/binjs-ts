import * as assert from 'assert';
import { TextDecoder } from 'util';

import * as S from './schema';
import { ArrayStream, ReadStream, ReadStreamRecorder } from './io';
import { Grammar } from './grammar';
import { MruDeltaReader } from './delta';
import { rewriteAst } from './ast_util';

export class Decoder {
    readonly r: ReadStream;
    public grammar: Grammar;
    public program: S.Program;

    constructor(r: ReadStream) {
        this.r = r;
    }

    public decode(): void {
        this.grammar = this.decodeGrammar();
        this.program = this.decodeAbstractSyntax();
    }

    decodeGrammar(): Grammar {
        let length = this.r.readVarUint();
        let source = this.r.readUtf8Bytes(length);
        let rules = JSON.parse(source);
        return new Grammar(rules);
    }

    decodeAbstractSyntax(): S.Program {
        const num_parameters = this.r.readVarUint();
        const num_built_in_tags = this.r.readVarUint();
        if (num_built_in_tags < 6) {
            throw Error('not yet implemented: decode fewer than 6 tags');
        } else if (num_built_in_tags !== 6) {
            throw Error(`decoder too old: encountered more than 6 built-in tags (${num_built_in_tags})`);
        }
        const first_built_in_tag = num_parameters;
        const tag_nil = first_built_in_tag + 0;
        const tag_null = first_built_in_tag + 1;
        const tag_cons = first_built_in_tag + 2;
        const tag_false = first_built_in_tag + 3;
        const tag_true = first_built_in_tag + 4;
        const tag_undefined = first_built_in_tag + 5;

        const first_meta_rule = first_built_in_tag + num_built_in_tags;
        const num_ranks = this.r.readVarUint() + 1;
        // The i-th rank's rules have this many parameters.
        const ranks = Array(num_ranks);
        ranks[0] = 0;
        // The next i-th rank's rule should appear at this offset.
        const rank_offset = Array(num_ranks + 1);
        rank_offset[0] = 0;
        rank_offset[1] = this.r.readVarUint();
        let meta_rule_size_offset = new Map<number, number>([[0, 0]]);
        for (let i = 1; i < num_ranks; i++) {
            ranks[i] = ranks[i - 1] + this.r.readVarUint() + 1;
            rank_offset[i + 1] = rank_offset[i] + this.r.readVarUint();
        }
        const num_meta_rules = rank_offset[num_ranks];
        const last_meta_rule = first_meta_rule + num_meta_rules - 1;

        const first_grammar_rule = first_meta_rule + num_meta_rules;
        const num_grammar_rules = this.grammar.rules.size;
        const last_grammar_rule = first_grammar_rule + num_grammar_rules - 1;

        const first_string_constant = first_grammar_rule + num_grammar_rules;
        const num_string_constants = this.r.readVarUint();
        const last_string_constant = first_string_constant + num_string_constants - 1;
        const string_lengths = Array(num_string_constants);
        const string_constants = Array(num_string_constants);
        for (let i = 0; i < num_string_constants; i++) {
            string_lengths[i] = this.r.readVarUint();
        }
        for (let i = 0; i < num_string_constants; i++) {
            string_constants[i] = this.r.readUtf8Bytes(string_lengths[i]);
        }

        const first_numeric_constant = first_string_constant + num_string_constants;
        const num_numeric_constants = this.r.readVarUint();
        const last_numeric_constant = first_numeric_constant + num_numeric_constants - 1;
        const numeric_constants = Array(num_numeric_constants);
        for (let i = 0; i < num_numeric_constants; i++) {
            numeric_constants[i] = this.decodeFloat();
        }

        // Given an index into the meta rules, returns the rank of that rule.
        let meta_rank = (i: number): number => {
            assert(0 <= i && i < num_meta_rules, `${i}`);
            // TODO(dpc): This should binary search.
            for (let j = 0; j < num_ranks; j++) {
                if (i < rank_offset[j + 1]) {
                    return ranks[j];
                }
            }
            assert(false, 'unreachable');
        };

        // Reads and caches tree data.
        let buffer_tree = (n: number, buffer: number[]): number[] => {
            for (let i = 0; i < n; i++) {
                const tag = this.r.readVarUint();
                buffer.push(tag);
                if (tag === tag_cons) {
                    buffer_tree(2, buffer);
                } else if (first_meta_rule <= tag && tag <= last_meta_rule) {
                    buffer_tree(meta_rank(tag - first_meta_rule), buffer);
                } else if (first_grammar_rule <= tag && tag <= last_grammar_rule) {
                    let kind = this.grammar.nodeType(tag - first_grammar_rule);
                    buffer_tree(this.grammar.rules.get(kind).length, buffer);
                } else {
                    // Nothing to do!
                }
            }
            return buffer;
        };

        // Read the meta rules.
        let rank_i = 0;
        let meta_rules = Array(num_meta_rules);
        for (let i = 0; i < num_meta_rules; i++) {
            while (rank_offset[rank_i + 1] < i) {
                rank_i++;
            }
            meta_rules[i] = buffer_tree(1, []);
        }

        const start_production = buffer_tree(1, []);

        let replay_tree = (tree: Iterator<number>, actuals: any[], debug: boolean): any => {
            let d = debug ? console.log : (...arg) => void (0);
            let tag = tree.next().value;
            if (tag === tag_nil) {
                d('prim:nil');
                return [];
            } else if (tag === tag_null) {
                d('prim:null');
                return null;
            } else if (tag === tag_cons) {
                d('prim:cons');
                const elem = replay_tree(tree, actuals, debug);
                const rest = replay_tree(tree, actuals, debug);
                rest.unshift(elem);
                return rest;
            } else if (tag === tag_false) {
                d('prim:false');
                return false;
            } else if (tag === tag_true) {
                d('prim:true');
                return true;
            } else if (tag === tag_undefined) {
                d('prim:undefined');
                return undefined;
            } else if (0 <= tag && tag < num_parameters) {
                d(`param:${tag}`);
                assert(tag < actuals.length);
                return actuals[tag];
            } else if (first_meta_rule <= tag && tag <= last_meta_rule) {
                const rule_i = tag - first_meta_rule;
                const rank = meta_rank(rule_i);
                d(`P${rule_i}/${rank}`);
                const rule_actuals = Array(rank);
                for (let i = 0; i < rank; i++) {
                    rule_actuals[i] = replay_tree(tree, actuals, debug);
                }
                return replay_tree(meta_rules[rule_i][Symbol.iterator](), rule_actuals, false);
            } else if (first_grammar_rule <= tag && tag <= last_grammar_rule) {
                const kind = this.grammar.nodeType(tag - first_grammar_rule);
                const props = this.grammar.rules.get(kind);
                d(`node:${kind}/${props.length}`);
                const params = {};
                for (let prop of props) {
                    params[prop] = replay_tree(tree, actuals, debug);
                }
                return new S[kind](params);
            } else if (first_string_constant <= tag && tag <= last_string_constant) {
                const i = tag - first_string_constant;
                const s = string_constants[i];
                d(`string:${s}`);
                return s;
            } else if (first_numeric_constant <= tag && tag <= last_numeric_constant) {
                const i = tag - first_numeric_constant;
                assert(0 <= i && i < numeric_constants.length);
                const n = numeric_constants[i];
                d(`float:${n}`);
                return n;
            } else {
                assert(false, `unreachable, read a bogus tag ${tag}`);
            }
        };

        const debug = false;
        return replay_tree(start_production[Symbol.iterator](), [], debug);
    }

    private decodeFloat(): number {
        let buf = this.r.readBytes(8);
        let float_buf = new Float64Array(buf.buffer.slice(0, 8));
        return float_buf[0];
    }
}
