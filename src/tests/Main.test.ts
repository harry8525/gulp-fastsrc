/// <reference path='../../typings/main.d.ts' />
import Helper from './Helper';
import {fillCache} from '../FastSrc';
import * as path from 'path';

describe('basic', () => {
    Helper.beforeEach();

    Helper.it('no src', () => {
        return Helper.runTask('no src', () => {
            return fillCache('nosrc', [], Helper.getRoot());
        });
    });

    Helper.it('basic src', () => {
        return Helper.runTask('basic src', () => {
            return fillCache('basicsrc', [ path.join(Helper.getRoot(), '*') ], Helper.getRoot());
        });
    });
});