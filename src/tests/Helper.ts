import q = require('q');

export default class Helper {
    public static it<T>(name: string, run: () => q.Promise<T>) {
        it(name, (done: (err?: any) => void) => {
            run().then(() => {
                done();
            }, (err: any) => {
                done(err);
            });
        });
    }

    public static runPipe(run: () => NodeJS.ReadWriteStream) {
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
}