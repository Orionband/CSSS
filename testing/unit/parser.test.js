const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getXmlValue, parseCiscoConfig } = require('../../src/worker/parser');

describe('parser', () => {
    describe('getXmlValue', () => {
        it('navigates nested objects', () => {
            const root = { A: { B: { C: 'value' } } };
            assert.equal(getXmlValue(root, ['A', 'B', 'C']), 'value');
        });

        it('unwraps xml2js text nodes', () => {
            const root = { NAME: { _: 'Router1' } };
            assert.equal(getXmlValue(root, ['NAME']), 'Router1');
        });

        it('unwraps single-element arrays', () => {
            const root = { PORT: [{ IP: { _: '10.0.0.1' } }] };
            assert.equal(getXmlValue(root, ['PORT', 'IP']), '10.0.0.1');
        });

        it('returns null for missing path', () => {
            const root = { A: { B: 1 } };
            assert.equal(getXmlValue(root, ['A', 'X', 'Y']), null);
        });

        it('returns null when path hits a primitive early', () => {
            assert.equal(getXmlValue({ A: 'done' }, ['A', 'B']), null);
        });
    });

    describe('parseCiscoConfig', () => {
        it('parses global and block lines', () => {
            const lines = [
                'hostname R1',
                'interface GigabitEthernet0/0',
                ' ip address 10.0.0.1 255.255.255.0',
                ' description uplink',
            ];
            const cfg = parseCiscoConfig(lines);
            assert.deepEqual(cfg.global, ['hostname R1', 'interface GigabitEthernet0/0']);
            assert.deepEqual(cfg.blocks['interface GigabitEthernet0/0'], [
                'ip address 10.0.0.1 255.255.255.0',
                'description uplink',
            ]);
        });

        it('skips ! and end lines', () => {
            const cfg = parseCiscoConfig(['hostname R1', '!', 'end']);
            assert.deepEqual(cfg.global, ['hostname R1']);
        });

        it('returns empty structure for empty input', () => {
            const cfg = parseCiscoConfig([]);
            assert.deepEqual(cfg.global, []);
            assert.equal(Object.keys(cfg.blocks).length, 0);
        });

        it('handles xml2js line objects', () => {
            const cfg = parseCiscoConfig([{ _: 'hostname SW1' }]);
            assert.deepEqual(cfg.global, ['hostname SW1']);
        });
    });
});
