/// <reference path='../../typings/main.d.ts' />
import chai = require('chai');
let expect = chai.expect;

describe('basic', () => {
    it('test', () => {
        expect(1, 'test');
    });
});