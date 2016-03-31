import q = require('q');
import {init} from '../FastSrc';

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
        it(name, (done: (err?: any) => void) => {
            run().then(() => {
                done();
            }, (err: any) => {
                done(err);
            });
        });
    }

    public static beforeEach() {
        beforeEach(() => {
            this.errorLogs = [];
            this.logs = [];
            this.cache = {};
            this.cacheSaveCallbacks = {};

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
                run().on('end', () => {
                    resolve(true);
                }).on('error', (err: any) => {
                    reject(err);
                });
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