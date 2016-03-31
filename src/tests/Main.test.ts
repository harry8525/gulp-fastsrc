/// <reference path='../../typings/main.d.ts' />
import chai = require('chai');
import Helper from './Helper';
import {fillCache} from '../FastSrc';
let expect = chai.expect;

describe('basic', () => {
    Helper.it('test', () => {
        return Helper.runPipe(() => {
            return fillCache('test', 'test/test/*', 'root');
        });
    });
});