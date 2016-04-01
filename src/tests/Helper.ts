import q = require('q');
import {init} from '../FastSrc';
import * as os from 'os';
import * as path from 'path';
import eos = require('end-of-stream');
import * as through2 from 'through2';
import * as gutil from 'gulp-util';

export default class Helper {
    public static errorLogs: string[] = [];
    public static logs: string[] = [];
    public static cache: { [key: string]: any } = {};
    public static cacheSaveCallbacks: { [key: string]: () => any } = {};
    public static endSrcData: {
        [key: string]: {
            startTime: number[];
            fileCount: number;
        }
    } = {};

    public static gulpCallbacks: {
        [key: string]: (data: any) => void
    } = {};

    public static it<T>(name: string, run: () => q.Promise<T>) {
        it(name, function(done: (err?: any) => void) {
            this.timeout(60000);
            run().then(() => {
                done();
            }, (err: any) => {
                done(err);
            });
        });
    }

    public static getRoot() {
        return path.join(os.tmpdir(), 'gulp-fastsrc');
    }

    public static beforeEach() {
        beforeEach(() => {
            this.errorLogs = [];
            this.logs = [];
            this.cache = {};
            this.cacheSaveCallbacks = {};
            this.endSrcData = {};
            this.gulpCallbacks = {};

            init({
                gulp: <any>{
                    on: (name: string, callback: (e: any) => void) => {
                        this.handleGulpOnRegistration(name, callback);
                    }
                },
                log: (...s: string[]) => {
                    this.handleLog(...s);
                },
                error: (...s: string[]) => {
                    this.handleError(...s);
                },
                isWatchMode: false,
                saveSection: (name: string, saveCallback: () => any) => {
                    this.handleSaveSection(name, saveCallback);
                },
                getSection: (name: string) => {
                    return this.handleGetSection(name);
                },
                endTaskSrc: (taskName: string, startTime: number[], fileCount: number) => {
                    this.handleEndTaskSrc(taskName, startTime, fileCount);
                }
            });
        });
    }

    public static runTask(taskName: string, run: () => NodeJS.ReadWriteStream) {
        return q.Promise<boolean>(
            (
                resolve: (res: boolean) => void,
                reject: (error: any) => void
            ) => {
                let stream = run();
                eos(stream, {
                    error: true,
                    readable: stream.readable,
                    writable: stream.writable && !stream.readable
                }, (err: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });

                stream.pipe(through2.obj(
                    function(file: gutil.File, encoding: string, callback: (p?: any) => void) {
                        'use strict';

                        callback2();
                    },
                    function(callback: () => void) {
                        'use strict';
                        callback();
                    }));
            });
    }

    private static handleGulpOnRegistration(name: string, callback: (e: any) => void) {
        this.gulpCallbacks[name] = callback;
    }

    private static handleLog(...s: string[]) {
        this.logs.push(s.join(' '));
    }

    private static handleError(...s: string[]) {
        this.errorLogs.push(s.join(' '));
    }

    private static handleSaveSection(name: string, saveCallback: () => any) {
        this.cacheSaveCallbacks[name] = saveCallback;
    }

    private static handleGetSection(name: string) {
        return this.cache[name];
    }

    private static handleEndTaskSrc(taskName: string, startTime: number[], fileCount: number) {
        this.endSrcData[taskName] = { startTime: startTime, fileCount: fileCount };
    }
}