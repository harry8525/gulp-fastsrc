/// <reference path='../../typings/main.d.ts' />
import Helper from './Helper';
import {fillCache} from '../FastSrc';

describe('basic', () => {
    Helper.beforeEach();

    Helper.it('test', () => {
        return Helper.runTask('test', () => {
            return fillCache('test', '*', Helper.getRoot());
        });
    });
});