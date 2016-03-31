/// <reference path='../typings/main.d.ts' />

/**
 * This file has helpers to speed up gulp.src. 
 * It creates a really fast in memory cache of 
 * all of the src contents. This removes a ton of IO
 * from the build. It also has helpers to filter 
 * out files that have not changed and cache 
 * this between builds to allow for it to be super
 * fast for incremental changes.
 */

/* tslint:disable:forin */
/* tslint:disable:no-string-literal */

import * as through2 from 'through2';
import * as es from 'event-stream';
import * as vinylfs from 'vinyl-fs';
import * as gutil from 'gulp-util';
import * as path from 'path';
import * as minimatch from 'minimatch';
import q = require('q');
import touch = require('touch');
import gulpType = require('gulp');
import { Readable } from 'stream';

interface ICacheNode {
    ____dir: any;
    [key: string]: ICacheNode | gutil.File;
}

interface IAddFileCacheOutput {
    file: gutil.File;
    newFile: boolean;
}

export interface ISourceOptions {
    alwaysPassThrough?: boolean;
    base?: string;
    since?: number;
    follow?: boolean;
    allowEmpty?: boolean;
}

let Minimatch = minimatch.Minimatch;
let wiredUpGulp = false;
let taskStartTimes: { [key: string]: number } = null;
let newTaskStartTimes: { [key: string]: number } = {};
let treeCachedFileSources: ICacheNode = Object.create(null);
let devLinkPaths: { [key: string]: string[] } = Object.create(null);
let regexCache = Object.create(null);
let lastFillCacheRun = null;
let changedFiles = Object.create(null);
let filesToTouch: string[] = null;
let fileDependencyGraph: { [key: string]: string } = null;
let hasTouchedFiles = false;
let getSection: (sectionName: string) => any = null;
let isWatchMode: boolean = false;
let gulp: gulpType.Gulp;
let log: (...s: string[]) => void;
let error: (...s: string[]) => void;
let endTaskSrc: (taskName: string, startHrtime: number[], fileCount: number) => void;

const FILE_CHANGE_SMUGE_TIME = 50;

const TASK_START_TIMES_CACHE_SECTION = 'fastSrc-taskStartTimes';
const FILES_TO_TOUCH_CACHE_SECTION = 'fastSrc-filesToTouch';
const FILE_DEPENDENCY_GRAPH_CACHE_SECTION = 'fastSrc-fileDependencyGraph';

function fixUpNewPaths(file: gutil.File) {
    'use strict';

    if (path.sep === '\\') {
        file.path = file.path.replace(/\//g, '\\');
    }
}

export function init(
    options: {
        gulp: gulpType.Gulp,
        isWatchMode: boolean,
        log: (...s: string[]) => void,
        error: (...s: string[]) => void,
        endTaskSrc: (taskName: string, startHrtime: number[], fileCount: number) => void,
        saveSection: (
            name: string,
            saveCallback: () => any)
            => void,
        getSection: (sectionName: string) => any
    }) {
    'use strict';

    isWatchMode = options.isWatchMode;
    getSection = options.getSection;
    log = options.log;
    error = options.error;
    gulp = options.gulp;
    endTaskSrc = options.endTaskSrc;

    options.saveSection(TASK_START_TIMES_CACHE_SECTION, function() {
        'use strict';
        return taskStartTimes;
    });

    options.saveSection(FILES_TO_TOUCH_CACHE_SECTION, function() {
        'use strict';
        return { filesToTouch: filesToTouch };
    });

    options.saveSection(FILE_DEPENDENCY_GRAPH_CACHE_SECTION, function() {
        'use strict';
        return fileDependencyGraph;
    });

    if (!wiredUpGulp) {
        wiredUpGulp = true;
        gulp['on']('task_stop', function(e: any) {
            'use strict';
            setTaskAsCompleted(e.task);
        });

        gulp['on']('task_err', function(e: any) {
            'use strict';
            setTaskAsErrored(e.task);
        });
    }
}

export function setTaskAsCompleted(taskName: string) {
    'use strict';
    if (newTaskStartTimes[taskName]) {
        taskStartTimes[taskName] = newTaskStartTimes[taskName];
    }
}

export function setTaskAsErrored(taskName: string) {
    'use strict';
    if (newTaskStartTimes[taskName]) {
        delete newTaskStartTimes[taskName];
    }
}

export function addSymlink(pathToLink: string, linkPath: string) {
    'use strict';

    let devLinkPathArray = devLinkPaths[pathToLink];
    if (!devLinkPathArray) {
        devLinkPathArray = devLinkPaths[pathToLink] = [];
    }
    devLinkPathArray.push(linkPath);
}

export function listenToWatchChanges(watcher: any) {
    'use strict';
    watcher['on']('change', function(filePath: string) {
        changedFiles[path.normalize(filePath)] = true;
    });

    watcher['on']('add', function(filePath: string) {
        changedFiles[path.normalize(filePath)] = true;
    });

    watcher['on']('unlink', function(filePath: string) {
        removeFileFromCache(path.join(process.cwd(), filePath));
    });
}

export function reprocessFileOnNextBuild(filePath: string) {
    'use strict';
    filePath = path.normalize(filePath);
    filesToTouch.push(filePath);
}

export function touchAllFiles() {
    'use strict';
    let promises: q.IPromise<void>[] = [];

    // Make sure we dont reset the files to touch in watch mode
    if (!isWatchMode) {
        let section = getSection(FILES_TO_TOUCH_CACHE_SECTION);

        if (section) {
            filesToTouch = section.filesToTouch || [];
        }
    } else if (!filesToTouch) {
        filesToTouch = [];
    }

    if (!isWatchMode || !hasTouchedFiles) {
        hasTouchedFiles = true;
        log(`Touching ${filesToTouch.length} files so they will be rebuilt`);

        function createPromise(filePath: string) {
            return q.Promise<void>((resolved: () => void, reject: (error: any) => void) => {
                touch(filePath, {
                    nocreate: true
                }, function(err: any) {
                    if (err) {
                        reject(err);
                    } else {
                        resolved();
                    }
                });
            });
        }

        for (let fileToTouch of filesToTouch) {
            promises.push(createPromise(fileToTouch));
        }
    } else {
        log(`In watch mode adding ${filesToTouch.length} files to changed list`);

        for (let fileToTouch of filesToTouch) {
            // make sure its hit on next run in watch mode
            changedFiles[fileToTouch] = true;
        }
    }

    // Reset files to touch
    filesToTouch = [];

    return q.all(promises);
}

export function fillCache(taskName: string, srcGlob: string | string[], rootPath: string, addMode?: boolean) {
    'use strict';
    let srcOptions: ISourceOptions = {
        base: rootPath,
        follow: true,
        allowEmpty: true
    };

    let readSrcGlob = srcGlob;

    let updateMTime = false;

    if (!addMode) {
        // reset changed files
        let localChangedFiles = changedFiles;
        changedFiles = Object.create(null);

        if (lastFillCacheRun) {
            srcOptions.since = lastFillCacheRun;

            // If in watch mode and its not the first read
            // only send the changed files
            if (isWatchMode) {
                updateMTime = true;
                readSrcGlob = [];
                srcOptions.since = undefined;
                for (let x in localChangedFiles) {
                    (<string[]>readSrcGlob).push(x);
                }
            }
        }

        lastFillCacheRun = (new Date()).getTime();
    }

    let startHrtime = process.hrtime();
    let fileCount = 0;

    // Vinyl fs errors is the read src glob is empty
    if (readSrcGlob.length > 0) {
        return vinylfs.src(readSrcGlob, srcOptions)
            .pipe(through2.obj(
                function(file: gutil.File, encoding: string, callback: (p?: any) => void) {
                    'use strict';
                    if (!file['isDirectory']()) {
                        fixUpNewPaths(file);

                        // Make sure all files changed between watches
                        // are treated as files that have changed
                        if (updateMTime) {
                            file.stat.mtime = new Date();
                        }

                        // Cache file
                        addFileToCache(file);

                        addDevLinkPaths(file);

                        this.push(file);
                        fileCount++;
                    }

                    callback();
                },
                function(callback: () => void) {
                    'use strict';
                    endTaskSrc(taskName, startHrtime, fileCount);
                    callback();
                }));
    } else {
        // Return empty stream
        let stream = es.readable(function() {
            this.emit('end');
        });

        return <NodeJS.ReadWriteStream><any>stream;
    }
}

export function cacheDest(destLocation: string, options?: {
    rootExtensions: string[]
}) {
    'use strict';

    return through2.obj(
        function(file: gutil.File, encoding: string, callback: () => void) {

            if (!fileDependencyGraph) {
                fileDependencyGraph = getSection(FILE_DEPENDENCY_GRAPH_CACHE_SECTION);
            }

            // Create a dependency graph to use to detect deleted files
            if (file.history &&
                file.history.length &&
                file.history.length > 1) {
                let outputPaths = [];
                let originalPath = file.history[0];

                if (options && options.rootExtensions) {
                    for (let ext of options.rootExtensions) {
                        let newPath = gutil.replaceExtension(originalPath, ext);
                        let filteredFiles = getFilteredFiles(newPath, {});
                        if (filteredFiles.length === 1) {
                            outputPaths.push(newPath);
                            break;
                        }
                    }
                } else {
                    outputPaths.push(originalPath);
                }

                for (let outputPath of outputPaths) {
                    fileDependencyGraph[file.history[file.history.length - 1]] = outputPath;
                }
            }

            // Cache file
            let newFile = file.clone({ deep: false, contents: false });

            let output = addFileToCache(newFile);
            addDevLinkPaths(newFile);

            if (output.newFile || !(<Buffer>newFile.contents).equals(<Buffer>output.file.contents)) {
                newFile.stat.mtime = new Date();
            }

            this.push(file);
            callback();
        });
};

export function hasWork(taskName: string, srcGlob: string | string[]) {
    'use strict';
    if (!taskStartTimes) {
        taskStartTimes = getSection(TASK_START_TIMES_CACHE_SECTION);
    }

    let lastRun = taskStartTimes[taskName];

    if (!lastRun) {
        return true;
    } else {
        if (srcGlob) {
            lastRun += FILE_CHANGE_SMUGE_TIME;

            let filteredFiles = getFilteredFiles(srcGlob, {});

            for (let file of filteredFiles) {
                // Filter out files that havent changed
                if (lastRun < file.stat.mtime.getTime()) {
                    return true;
                }
            }
        }

        return false;
    }
}

export function wasFileDeleted(file: gutil.File): boolean {
    'use strict';

    if (!fileDependencyGraph) {
        fileDependencyGraph = getSection(FILE_DEPENDENCY_GRAPH_CACHE_SECTION);
    }

    // Get to the root dependency
    let currentFile = file.path;
    while (currentFile) {
        let newCurrentFile = fileDependencyGraph[currentFile];
        if (!newCurrentFile) {
            break;
        }

        currentFile = newCurrentFile;
    }

    // See if the root dependency file is there
    return getFilteredFiles(currentFile, {}).length === 0;
}

export function getDeletedFiles(srcGlob: string | string[]) {
    'use strict';

    let deletedFiles: gutil.File[] = [];

    if (srcGlob) {

        let filteredFiles = getFilteredFiles(srcGlob, {});

        for (let file of filteredFiles) {
            if (wasFileDeleted(file)) {
                deletedFiles.push(file);
            }
        }
    }

    return deletedFiles;
}

export function getCachedFile(path: string): gutil.File {
    'use strict';
    let files = getFilteredFiles([path], {});
    return files.length > 0 ? files[0] : null;
}

export function cacheSrc(
    taskName: string,
    srcGlob: string | string[],
    srcOptions?: ISourceOptions): Readable {
    'use strict';
    srcOptions = srcOptions ? srcOptions : <ISourceOptions>{};

    if (!taskStartTimes) {
        taskStartTimes = getSection(TASK_START_TIMES_CACHE_SECTION);
    }

    let lastRun = taskStartTimes[taskName];
    if (lastRun) {
        lastRun += FILE_CHANGE_SMUGE_TIME;
        srcOptions.since = lastRun;
    }

    let newStartTime = (new Date()).getTime();

    // create a stream that waits and buffers until its later resumed
    let stream = es.readable(function() {
        let startHrtime = process.hrtime();

        let resultFiles = [];

        if (srcGlob) {
            let filteredFiles = getFilteredFiles(srcGlob, srcOptions);

            for (let file of filteredFiles) {
                // Filter out files that havent changed
                if (!lastRun || lastRun < file.stat.mtime.getTime()) {
                    resultFiles.push(file);
                }

                if (newStartTime < file.stat.mtime.getTime()) {
                    error(`File newer than start time ${file.path} - ${newStartTime} - ${file.stat.mtime}`);
                    newStartTime = file.stat.mtime.getTime();
                }
            }
        }

        newTaskStartTimes[taskName] = newStartTime;

        endTaskSrc(taskName, startHrtime, resultFiles.length);

        for (let y = 0; y < resultFiles.length; y++) {
            this.emit('data', resultFiles[y]);
        }
        this.emit('end');
    });

    return <any>stream;
}

export function cacheAllSrc(
    taskName: string,
    srcGlob: string | string[],
    srcOptions?: ISourceOptions): Readable {
    'use strict';
    srcOptions = srcOptions ? srcOptions : <ISourceOptions>{};

    if (!taskStartTimes) {
        taskStartTimes = getSection(TASK_START_TIMES_CACHE_SECTION);
    }

    let lastRun = taskStartTimes[taskName];

    if (lastRun) {
        lastRun += FILE_CHANGE_SMUGE_TIME;
    }

    let newStartTime = (new Date()).getTime();

    // create a stream that waits and buffers until its later resumed
    let stream = es.readable(function() {
        let startHrtime = process.hrtime();

        let foundChangedFile = false;

        let resultFiles = getFilteredFiles(srcGlob, srcOptions);

        for (let file of resultFiles) {
            // See if a file changed that we care about
            if (srcOptions.alwaysPassThrough || !lastRun || lastRun < file.stat.mtime.getTime()) {
                foundChangedFile = true;
                break;
            }
        }

        newTaskStartTimes[taskName] = newStartTime;

        endTaskSrc(taskName, startHrtime, foundChangedFile ? resultFiles.length : 0);

        if (foundChangedFile) {
            for (let y = 0; y < resultFiles.length; y++) {
                this.emit('data', resultFiles[y]);
            }
        }
        this.emit('end');
    });

    return <any>stream;
}

function makeAbsolute(str: string) {
    'use strict';
    if (path.isAbsolute(str)) {
        return str;
    } else {
        return path.join(process.cwd(), str);
    }
}

function addDevLinkPaths(file: gutil.File) {
    'use strict';
    for (let x in devLinkPaths) {
        if (file.path.indexOf(x) === 0) {
            for (let devLinkPath of devLinkPaths[x]) {
                let clonedFile = file.clone({ deep: false, contents: false });
                clonedFile.path = path.join(devLinkPath, file.path.substring(x.length));
                addFileToCache(clonedFile);
            }
        }
    }
}

function normalizeFileCachePath(filePath: string) {
    'use strict';
    return filePath.replace(/\\/g, '/').toLowerCase();
}

function splitFilePath(filePath: string) {
    'use strict';
    // Build a tree of the source files for fast look up
    let splitPath = normalizeFileCachePath(filePath).split('/');

    let lastIndex = splitPath.length - 1;
    let lastPathSegment = splitPath[lastIndex];

    return {
        lastIndex: lastIndex,
        lastPathSegment: lastPathSegment,
        splitPath: splitPath
    };
}

function addFileToCache(file: gutil.File): IAddFileCacheOutput {
    'use strict';

    let result = splitFilePath(file.path);
    let splitPath = result.splitPath;
    let lastIndex = result.lastIndex;
    let lastPathSegment = result.lastPathSegment;

    let fileAtLocation: gutil.File = null;

    if (lastIndex === 0) {
        fileAtLocation = <gutil.File>treeCachedFileSources[lastPathSegment];
        treeCachedFileSources[lastPathSegment] = file;
    } else if (lastIndex > 0) {
        let currentSegment: ICacheNode | gutil.File = treeCachedFileSources;

        for (let x = 0; x < lastIndex; x++) {
            let pathSegment = splitPath[x];

            // Overwrite anything that is not a file
            if (!currentSegment[pathSegment] || !(<ICacheNode>currentSegment[pathSegment]).____dir) {
                let dir = Object.create(null);
                dir.____dir = true;
                currentSegment[pathSegment] = dir;
            }

            currentSegment = currentSegment[pathSegment];
        }
        fileAtLocation = currentSegment[lastPathSegment];
        currentSegment[lastPathSegment] = file;
    }

    return { file: fileAtLocation, newFile: !fileAtLocation };
}

function removeFileFromCache(filePath: string): IAddFileCacheOutput {
    'use strict';

    // Remove devlinks too
    let normalizeFilePath = normalizeFileCachePath(filePath);
    for (let x in devLinkPaths) {
        let normalizedDevLink = normalizeFileCachePath(x);
        if (normalizeFilePath.indexOf(normalizedDevLink) === 0) {
            for (let devLinkPath of devLinkPaths[x]) {
                let pathToDelete = path.join(devLinkPath, filePath.substring(x.length));
                removeFileFromCache(pathToDelete);
            }
        }
    }

    let result = splitFilePath(filePath);
    let splitPath = result.splitPath;
    let lastIndex = result.lastIndex;
    let lastPathSegment = result.lastPathSegment;

    if (lastIndex === 0) {
        delete treeCachedFileSources[lastPathSegment];
    } else if (lastIndex > 0) {
        let currentSegment: ICacheNode | gutil.File = treeCachedFileSources;

        for (let x = 0; x < lastIndex; x++) {
            let pathSegment = splitPath[x];

            if (currentSegment[pathSegment]) {
                currentSegment = currentSegment[pathSegment];
            } else {
                // Break early since the file is not found
                return;
            }
        }

        if (currentSegment[lastPathSegment]) {
            delete currentSegment[lastPathSegment];
        }
    }
}

function getFilteredFiles(srcGlob: string | string[], srcOptions: ISourceOptions) {
    'use strict';
    srcGlob = typeof srcGlob === 'string' ? [srcGlob] : srcGlob;

    let resultFiles: gutil.File[] = [];
    let negateFiles: gutil.File[] = [];

    for (let x = 0; x < srcGlob.length; x++) {
        if (srcGlob[x][0] !== '!') {
            getFilesFromSearch(resultFiles, makeAbsolute(srcGlob[x]), srcOptions);
        } else {
            getFilesFromSearch(negateFiles, makeAbsolute(srcGlob[x].substring(1)), srcOptions);
        }
    }

    // Remove any files from the negation
    for (let y = 0; y < negateFiles.length; y++) {
        let negateFile = negateFiles[y];
        for (let i = 0; i < resultFiles.length; i++) {
            if (negateFile.path === resultFiles[i].path) {
                resultFiles.splice(i, 1);
                break;
            }
        }
    }

    return resultFiles;
}

function getFilesFromSearch(resultFiles: gutil.File[], pattern: string, srcOptions: ISourceOptions) {
    'use strict';

    // Make sure the pattern path is absolute
    if (!path.isAbsolute(pattern)) {
        pattern = path.join(process.cwd(), pattern);
    }

    let splitPattern = pattern.replace(/\\/g, '/').split('/');

    let originalPattern: string[] = [];

    // Make sure all paths are lower case to handle path differences
    for (let x = 0; x < splitPattern.length; x++) {
        // Keep the original patter for case sensitive file systems (MAC) since
        // we use it for generating the base paths
        originalPattern.push(splitPattern[x]);
        splitPattern[x] = splitPattern[x].toLowerCase();
    }

    let lastIndex = splitPattern.length - 1;

    if (splitPattern[lastIndex].indexOf('.') < 0 && splitPattern[lastIndex] !== '*') {
        error('FastSrc needs a dot in last segment of path match - ' + pattern);
    }

    let currentSegment: ICacheNode | gutil.File = treeCachedFileSources;

    for (let x = 0; x < splitPattern.length; x++) {
        let pathSegment = splitPattern[x];
        if (pathSegment === '**' || pathSegment.indexOf('*') >= 0) {
            let base = srcOptions && srcOptions.base ?
                srcOptions.base :
                originalPattern.slice(0, x).join(path.sep);
            getAllFilesUnderNode(
                resultFiles,
                currentSegment,
                pattern,
                splitPattern,
                lastIndex,
                base,
                pathSegment === '**',
                false);
            break;
        } else {
            if (!currentSegment) {
                break;
            }

            currentSegment = currentSegment[pathSegment];

            // We have a file that matches the last segement
            if (x === splitPattern.length - 1 &&
                currentSegment &&
                !(<ICacheNode>currentSegment).____dir) {
                let base2 = srcOptions && srcOptions.base ?
                    srcOptions.base :
                    originalPattern.slice(0, x).join(path.sep);
                let result = (<gutil.File>currentSegment).clone({ deep: false, contents: false });
                result.base = makeAbsolute(base2);
                resultFiles.push(result);
            }
        }
    }
}

function getAllFilesUnderNode(
    resultFiles: gutil.File[],
    currentSegment: ICacheNode | gutil.File,
    pattern: string,
    splitPattern: string[],
    lastIndex: number,
    base: string,
    traverse: boolean,
    takeAllFilesUnder: boolean) {
    'use strict';
    for (let x in currentSegment) {
        if (x !== '____dir') {
            let segment = currentSegment[x];

            if (segment.____dir && traverse) {
                getAllFilesUnderNode(
                    resultFiles,
                    segment,
                    pattern,
                    splitPattern,
                    lastIndex,
                    base,
                    traverse,
                    takeAllFilesUnder);
            } else if (takeAllFilesUnder || fileMatchesRegex(splitPattern[lastIndex], x)) {
                if (segment.____dir) {
                    // We have a dir hit so we need to do a traverse on it 
                    // and take all files under it (e.g. /knockout/*)
                    getAllFilesUnderNode(
                        resultFiles,
                        segment,
                        pattern,
                        splitPattern,
                        lastIndex,
                        base,
                        true,
                        true);
                } else {
                    let result = segment.clone({ deep: false, contents: false });
                    result.base = makeAbsolute(base);
                    resultFiles.push(result);
                }
            }
        }
    }
}

function fileMatchesRegex(filePattern: string, fileName: string) {
    'use strict';
    let regex = regexCache[filePattern];
    if (!regex) {
        let mm = new Minimatch(filePattern);
        mm.makeRe();
        regex = regexCache[filePattern] = mm.regexp;
    }

    return !!regex.exec(fileName);
}