const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const CryptMD5 = require('cryptmd5');
const { evaluateCondition } = require('../../src/worker/grading');
const { mockDevice } = require('../helpers/mockDevice');

describe('grading', () => {
    it('XmlMatch matches trimmed values', () => {
        const device = mockDevice({
            xmlRoot: { PORT: { IP: { _: ' 10.1.1.1 ' } } },
        });
        assert.equal(evaluateCondition(device, {
            type: 'XmlMatch',
            path: ['PORT', 'IP'],
            value: '10.1.1.1',
        }), true);
    });

    it('XmlMatchNot passes when value does not match', () => {
        const device = mockDevice({
            xmlRoot: { GATEWAY: { _: '10.0.0.1' } },
        });
        assert.equal(evaluateCondition(device, {
            type: 'XmlMatchNot',
            path: ['GATEWAY'],
            value: '10.0.0.254',
        }), true);
    });

    it('XmlMatchNot fails when value matches', () => {
        const device = mockDevice({
            xmlRoot: { GATEWAY: { _: '10.0.0.254' } },
        });
        assert.equal(evaluateCondition(device, {
            type: 'XmlMatchNot',
            path: ['GATEWAY'],
            value: '10.0.0.254',
        }), false);
    });

    it('ConfigMatch finds line in block context', () => {
        const device = mockDevice({
            runningLines: [
                'hostname R1',
                'interface Vlan1',
                ' ip address 192.168.1.1 255.255.255.0',
            ],
        });
        assert.equal(evaluateCondition(device, {
            type: 'ConfigMatch',
            source: 'running',
            context: 'interface Vlan1',
            value: 'ip address 192.168.1.1 255.255.255.0',
        }), true);
    });

    it('ConfigRegex matches in global context', () => {
        const device = mockDevice({
            runningLines: ['hostname PIX-NYC-R1'],
        });
        assert.equal(evaluateCondition(device, {
            type: 'ConfigMatch',
            source: 'running',
            context: 'global',
            value: 'hostname PIX-NYC-R1',
        }), true);
    });

    it('ConfigMatch uses startup when source is startup', () => {
        const device = mockDevice({
            startupLines: ['hostname STARTUP'],
            runningLines: ['hostname RUNNING'],
        });
        assert.equal(evaluateCondition(device, {
            type: 'ConfigMatch',
            source: 'startup',
            context: 'global',
            value: 'hostname STARTUP',
        }), true);
    });

    it('Type5Match device mode verifies enable secret', () => {
        const hash = CryptMD5.cryptMD5('cisco', 'mERr');
        const device = mockDevice({
            runningLines: [`enable secret 5 ${hash}`],
        });
        assert.equal(evaluateCondition(device, {
            type: 'Type5Match',
            source: 'running',
            mode: 'device',
            password: 'cisco',
        }), true);
    });

    it('Type5Match fails on wrong password', () => {
        const hash = CryptMD5.cryptMD5('cisco', 'mERr');
        const device = mockDevice({
            runningLines: [`enable secret 5 ${hash}`],
        });
        assert.equal(evaluateCondition(device, {
            type: 'Type5Match',
            source: 'running',
            mode: 'device',
            password: 'wrong',
        }), false);
    });

    it('returns false for missing device', () => {
        assert.equal(evaluateCondition(null, { type: 'XmlMatch', path: ['X'], value: 'y' }), false);
    });

    it('returns false for empty type', () => {
        const device = mockDevice();
        assert.equal(evaluateCondition(device, { type: '' }), false);
    });
});
