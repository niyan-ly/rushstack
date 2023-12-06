// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as child_process from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { EnvironmentMap } from './EnvironmentMap';

import { FileSystem } from './FileSystem';
import { PosixModeBits } from './PosixModeBits';
import { Text } from './Text';
import { InternalError } from './InternalError';

/**
 * Typings for one of the streams inside IExecutableSpawnSyncOptions.stdio.
 * @public
 */
export type ExecutableStdioStreamMapping =
  | 'pipe'
  | 'ignore'
  | 'inherit'
  | NodeJS.WritableStream
  | NodeJS.ReadableStream
  | number
  | undefined;

/**
 * Types for {@link IExecutableSpawnSyncOptions.stdio}
 * and {@link IExecutableSpawnOptions.stdio}
 * @public
 */
export type ExecutableStdioMapping = 'pipe' | 'ignore' | 'inherit' | ExecutableStdioStreamMapping[];

/**
 * Options for Executable.tryResolve().
 * @public
 */
export interface IExecutableResolveOptions {
  /**
   * The current working directory.  If omitted, process.cwd() will be used.
   */
  currentWorkingDirectory?: string;

  /**
   * The environment variables for the child process.
   *
   * @remarks
   * If `environment` and `environmentMap` are both omitted, then `process.env` will be used.
   * If `environment` and `environmentMap` cannot both be specified.
   */
  environment?: NodeJS.ProcessEnv;

  /**
   * The environment variables for the child process.
   *
   * @remarks
   * If `environment` and `environmentMap` are both omitted, then `process.env` will be used.
   * If `environment` and `environmentMap` cannot both be specified.
   */
  environmentMap?: EnvironmentMap;
}

/**
 * Options for {@link Executable.spawnSync}
 * @public
 */
export interface IExecutableSpawnSyncOptions extends IExecutableResolveOptions {
  /**
   * The content to be passed to the child process's stdin.
   *
   * NOTE: If specified, this content replaces any IExecutableSpawnSyncOptions.stdio[0]
   * mapping for stdin.
   */
  input?: string;

  /**
   * The stdio mappings for the child process.
   *
   * NOTE: If IExecutableSpawnSyncOptions.input is provided, it will take precedence
   * over the stdin mapping (stdio[0]).
   */
  stdio?: ExecutableStdioMapping;

  /**
   * The maximum time the process is allowed to run before it will be terminated.
   */
  timeoutMs?: number;

  /**
   * The largest amount of bytes allowed on stdout or stderr for this synchronous operation.
   * If exceeded, the child process will be terminated.  The default is 200 * 1024.
   */
  maxBuffer?: number;
}

/**
 * Options for {@link Executable.spawn}
 * @public
 */
export interface IExecutableSpawnOptions extends IExecutableResolveOptions {
  /**
   * The stdio mappings for the child process.
   *
   * NOTE: If IExecutableSpawnSyncOptions.input is provided, it will take precedence
   * over the stdin mapping (stdio[0]).
   */
  stdio?: ExecutableStdioMapping;
}

// Common environmental state used by Executable members
interface IExecutableContext {
  currentWorkingDirectory: string;
  environmentMap: EnvironmentMap;
  // For Windows, the parsed PATHEXT environment variable
  windowsExecutableExtensions: string[];
}

interface ICommandLineOptions {
  path: string;
  args: string[];
}

/**
 * Process information sourced from the system. This process info is sourced differently depending
 * on the operating system:
 * - On Windows, this uses the `wmic.exe` utility.
 * - On Unix, this uses the `ps` utility.
 *
 * @public
 */
export interface IProcessInfo {
  /**
   * The name of the process.
   *
   * @remarks On Windows, the process name will be empty if the process is a kernel process.
   * On Unix, the process name will be empty if the process is the root process.
   */
  processName: string;
  /**
   * The process ID.
   */
  processId: number;
  /**
   * The parent process info.
   *
   * @remarks On Windows, the parent process info will be undefined if the process is a kernel process.
   * On Unix, the parent process info will be undefined if the process is the root process.
   */
  parentProcessInfo: IProcessInfo | undefined;

  /**
   * The child process infos.
   */
  childProcessInfos: IProcessInfo[];
}

export async function parseProcessListOutputAsync(
  stream: NodeJS.ReadableStream
): Promise<Map<number, IProcessInfo>> {
  const processInfoById: Map<number, IProcessInfo> = new Map<number, IProcessInfo>();
  let seenHeaders: boolean = false;
  for await (const line of Text.readLinesFromIterableAsync(stream, { skipEmptyLines: true })) {
    if (!seenHeaders) {
      seenHeaders = true;
    } else {
      parseProcessInfoEntry(line, processInfoById);
    }
  }
  return processInfoById;
}

// eslint-disable-next-line @rushstack/no-new-null
export function parseProcessListOutput(output: Iterable<string | null>): Map<number, IProcessInfo> {
  const processInfoById: Map<number, IProcessInfo> = new Map<number, IProcessInfo>();
  let seenHeaders: boolean = false;
  for (const line of Text.readLinesFromIterable(output, { skipEmptyLines: true })) {
    if (!seenHeaders) {
      seenHeaders = true;
    } else {
      parseProcessInfoEntry(line, processInfoById);
    }
  }
  return processInfoById;
}

// win32 format:
// Name             ParentProcessId   ProcessId
// process name     1234              5678
// unix format:
// COMMAND             PPID     PID
// process name       51234   56784
const NAME_GROUP: 'name' = 'name';
const PROCESS_ID_GROUP: 'pid' = 'pid';
const PARENT_PROCESS_ID_GROUP: 'ppid' = 'ppid';
// eslint-disable-next-line @rushstack/security/no-unsafe-regexp
const PROCESS_LIST_ENTRY_REGEX: RegExp = new RegExp(
  `^(?<${NAME_GROUP}>.+?)\\s+(?<${PARENT_PROCESS_ID_GROUP}>\\d+)\\s+(?<${PROCESS_ID_GROUP}>\\d+)\\s*$`
);

function parseProcessInfoEntry(line: string, existingProcessInfoById: Map<number, IProcessInfo>): void {
  const match: RegExpMatchArray | null = line.match(PROCESS_LIST_ENTRY_REGEX);
  if (!match?.groups) {
    throw new InternalError(`Invalid process list entry: ${line}`);
  }

  const processName: string = match.groups[NAME_GROUP];
  const processId: number = parseInt(match.groups[PROCESS_ID_GROUP], 10);
  const parentProcessId: number = parseInt(match.groups[PARENT_PROCESS_ID_GROUP], 10);

  // Only care about the parent process if it is not the same as the current process.
  let parentProcessInfo: IProcessInfo | undefined;
  if (parentProcessId !== processId) {
    parentProcessInfo = existingProcessInfoById.get(parentProcessId);
    if (!parentProcessInfo) {
      // Create a new placeholder entry for the parent with the information we have so far
      parentProcessInfo = {
        processName: '',
        processId: parentProcessId,
        parentProcessInfo: undefined,
        childProcessInfos: []
      };
      existingProcessInfoById.set(parentProcessId, parentProcessInfo);
    }
  }

  let processInfo: IProcessInfo | undefined = existingProcessInfoById.get(processId);
  if (!processInfo) {
    // Create a new entry
    processInfo = {
      processName,
      processId,
      parentProcessInfo,
      childProcessInfos: []
    };
    existingProcessInfoById.set(processId, processInfo);
  } else {
    // Update placeholder entry
    processInfo.processName = processName;
    processInfo.parentProcessInfo = parentProcessInfo;
  }

  // Add the process as a child of the parent process
  parentProcessInfo?.childProcessInfos.push(processInfo);
}

function convertToProcessInfoByNameMap(
  processInfoById: Map<number, IProcessInfo>
): Map<string, IProcessInfo[]> {
  const processInfoByNameMap: Map<string, IProcessInfo[]> = new Map<string, IProcessInfo[]>();
  for (const processInfo of processInfoById.values()) {
    let processInfoNameEntries: IProcessInfo[] | undefined = processInfoByNameMap.get(
      processInfo.processName
    );
    if (!processInfoNameEntries) {
      processInfoNameEntries = [];
      processInfoByNameMap.set(processInfo.processName, processInfoNameEntries);
    }
    processInfoNameEntries.push(processInfo);
  }
  return processInfoByNameMap;
}

const OS_PLATFORM: NodeJS.Platform = os.platform();

function getProcessListProcessOptions(): ICommandLineOptions {
  let command: string;
  let args: string[];
  if (OS_PLATFORM === 'win32') {
    command = 'wmic.exe';
    // Order of declared properties does not impact the order of the output
    args = ['process', 'get', 'Name,ParentProcessId,ProcessId'];
  } else {
    command = 'ps';
    // -A: Select all processes
    // -o: User-defined format
    // Order of declared properties impacts the order of the output, so match
    // the order of wmic.exe output
    args = ['-Ao', 'comm,ppid,pid'];
  }
  return { path: command, args };
}

/**
 * The Executable class provides a safe, portable, recommended solution for tools that need
 * to launch child processes.
 *
 * @remarks
 * The NodeJS child_process API provides a solution for launching child processes, however
 * its design encourages reliance on the operating system shell for certain features.
 * Invoking the OS shell is not safe, not portable, and generally not recommended:
 *
 * - Different shells have different behavior and command-line syntax, and which shell you
 *   will get with NodeJS is unpredictable.  There is no universal shell guaranteed to be
 *   available on all platforms.
 *
 * - If a command parameter contains symbol characters, a shell may interpret them, which
 *   can introduce a security vulnerability
 *
 * - Each shell has different rules for escaping these symbols.  On Windows, the default
 *   shell is incapable of escaping certain character sequences.
 *
 * The Executable API provides a pure JavaScript implementation of primitive shell-like
 * functionality for searching the default PATH, appending default file extensions on Windows,
 * and executing a file that may contain a POSIX shebang.  This primitive functionality
 * is sufficient (and recommended) for most tooling scenarios.
 *
 * If you need additional shell features such as wildcard globbing, environment variable
 * expansion, piping, or built-in commands, then we recommend to use the `@microsoft/rushell`
 * library instead.  Rushell is a pure JavaScript shell with a standard syntax that is
 * guaranteed to work consistently across all platforms.
 *
 * @public
 */
export class Executable {
  /**
   * Synchronously create a child process and optionally capture its output.
   *
   * @remarks
   * This function is similar to child_process.spawnSync().  The main differences are:
   *
   * - It does not invoke the OS shell unless the executable file is a shell script.
   * - Command-line arguments containing special characters are more accurately passed
   *   through to the child process.
   * - If the filename is missing a path, then the shell's default PATH will be searched.
   * - If the filename is missing a file extension, then Windows default file extensions
   *   will be searched.
   *
   * @param filename - The name of the executable file.  This string must not contain any
   * command-line arguments.  If the name contains any path delimiters, then the shell's
   * default PATH will not be searched.
   * @param args - The command-line arguments to be passed to the process.
   * @param options - Additional options
   * @returns the same data type as returned by the NodeJS child_process.spawnSync() API
   *
   * @privateRemarks
   *
   * NOTE: The NodeJS spawnSync() returns SpawnSyncReturns<string> or SpawnSyncReturns<Buffer>
   * polymorphically based on the options.encoding parameter value.  This is a fairly confusing
   * design.  In most cases, developers want string with the default encoding.  If/when someone
   * wants binary output or a non-default text encoding, we will introduce a separate API function
   * with a name like "spawnWithBufferSync".
   */
  public static spawnSync(
    filename: string,
    args: string[],
    options?: IExecutableSpawnSyncOptions
  ): child_process.SpawnSyncReturns<string> {
    if (!options) {
      options = {};
    }

    const context: IExecutableContext = Executable._getExecutableContext(options);

    const resolvedPath: string | undefined = Executable._tryResolve(filename, options, context);
    if (!resolvedPath) {
      throw new Error(`The executable file was not found: "${filename}"`);
    }

    const spawnOptions: child_process.SpawnSyncOptionsWithStringEncoding = {
      cwd: context.currentWorkingDirectory,
      env: context.environmentMap.toObject(),
      input: options.input,
      stdio: options.stdio as child_process.StdioOptions,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,

      // Contrary to what the NodeJS typings imply, we must explicitly specify "utf8" here
      // if we want the result to be SpawnSyncReturns<string> instead of SpawnSyncReturns<Buffer>.
      encoding: 'utf8',

      // NOTE: This is always false, because Rushell will be recommended instead of relying on the OS shell.
      shell: false
    };

    const normalizedCommandLine: ICommandLineOptions = Executable._buildCommandLineFixup(
      resolvedPath,
      args,
      context
    );

    return child_process.spawnSync(normalizedCommandLine.path, normalizedCommandLine.args, spawnOptions);
  }

  /**
   * Start a child process.
   *
   * @remarks
   * This function is similar to child_process.spawn().  The main differences are:
   *
   * - It does not invoke the OS shell unless the executable file is a shell script.
   * - Command-line arguments containing special characters are more accurately passed
   *   through to the child process.
   * - If the filename is missing a path, then the shell's default PATH will be searched.
   * - If the filename is missing a file extension, then Windows default file extensions
   *   will be searched.
   *
   * This command is asynchronous, but it does not return a `Promise`.  Instead it returns
   * a Node.js `ChildProcess` supporting event notifications.
   *
   * @param filename - The name of the executable file.  This string must not contain any
   * command-line arguments.  If the name contains any path delimiters, then the shell's
   * default PATH will not be searched.
   * @param args - The command-line arguments to be passed to the process.
   * @param options - Additional options
   * @returns the same data type as returned by the NodeJS child_process.spawnSync() API
   */
  public static spawn(
    filename: string,
    args: string[],
    options?: IExecutableSpawnOptions
  ): child_process.ChildProcess {
    if (!options) {
      options = {};
    }

    const context: IExecutableContext = Executable._getExecutableContext(options);

    const resolvedPath: string | undefined = Executable._tryResolve(filename, options, context);
    if (!resolvedPath) {
      throw new Error(`The executable file was not found: "${filename}"`);
    }

    const spawnOptions: child_process.SpawnOptions = {
      cwd: context.currentWorkingDirectory,
      env: context.environmentMap.toObject(),
      stdio: options.stdio as child_process.StdioOptions,

      // NOTE: This is always false, because Rushell will be recommended instead of relying on the OS shell.
      shell: false
    };

    const normalizedCommandLine: ICommandLineOptions = Executable._buildCommandLineFixup(
      resolvedPath,
      args,
      context
    );

    return child_process.spawn(normalizedCommandLine.path, normalizedCommandLine.args, spawnOptions);
  }

  /**
   * Get the list of processes currently running on the system, keyed by the process ID. The underlying
   * implementation depends on the operating system:
   * - On Windows, this uses the `wmic.exe` utility.
   * - On Unix, this uses the `ps` utility.
   */
  public static async listProcessInfoByIdAsync(): Promise<Map<number, IProcessInfo>> {
    const { path: command, args } = getProcessListProcessOptions();
    const process: child_process.ChildProcess = Executable.spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (process.stdout === null) {
      throw new InternalError('Child process did not provide stdout');
    }

    let errorThrown: boolean = false;
    const processFinishedPromise: Promise<void> = new Promise<void>(
      (resolve: () => void, reject: (error: Error) => void) => {
        process.on('error', (error: Error) => {
          errorThrown = true;
          reject(new InternalError(`Unable to list processes: ${command} failed with error ${error}`));
        });
        process.on('exit', (code: number | null) => {
          if (errorThrown) {
            // We've already rejected the promise
            return;
          }
          if (code !== 0) {
            reject(new InternalError(`Unable to list processes: ${command} exited with code ${code}`));
          } else {
            resolve();
          }
        });
      }
    );

    const [processInfoByIdMap] = await Promise.all([
      parseProcessListOutputAsync(process.stdout),
      processFinishedPromise
    ]);
    return processInfoByIdMap;
  }

  /**
   * Get the list of processes currently running on the system, keyed by the process ID. The underlying
   * implementation depends on the operating system:
   * - On Windows, this uses the `wmic.exe` utility.
   * - On Unix, this uses the `ps` utility.
   */
  public static listProcessInfoById(): Map<number, IProcessInfo> {
    const { path: command, args } = getProcessListProcessOptions();
    const processOutput: child_process.SpawnSyncReturns<string> = Executable.spawnSync(command, args);
    if (processOutput.error) {
      throw new Error(`Unable to list processes: ${command} failed with error ${processOutput.error}`);
    }
    if (processOutput.status !== 0) {
      throw new Error(`Unable to list processes: ${command} exited with code ${processOutput.status}`);
    }
    return parseProcessListOutput(processOutput.output);
  }

  /**
   * Get the list of processes currently running on the system, keyed by the process name. All processes
   * with the same name will be grouped. The underlying implementation depends on the operating system:
   * - On Windows, this uses the `wmic.exe` utility.
   * - On Unix, this uses the `ps` utility.
   */
  public static async listProcessInfoByNameAsync(): Promise<Map<string, IProcessInfo[]>> {
    const processInfoById: Map<number, IProcessInfo> = await Executable.listProcessInfoByIdAsync();
    return convertToProcessInfoByNameMap(processInfoById);
  }

  /**
   * Get the list of processes currently running on the system, keyed by the process name. All processes
   * with the same name will be grouped. The underlying implementation depends on the operating system:
   * - On Windows, this uses the `wmic.exe` utility.
   * - On Unix, this uses the `ps` utility.
   */
  public static listProcessInfoByName(): Map<string, IProcessInfo[]> {
    const processInfoByIdMap: Map<number, IProcessInfo> = Executable.listProcessInfoById();
    return convertToProcessInfoByNameMap(processInfoByIdMap);
  }

  // PROBLEM: Given an "args" array of strings that may contain special characters (e.g. spaces,
  // backslashes, quotes), ensure that these strings pass through to the child process's ARGV array
  // without anything getting corrupted along the way.
  //
  // On Unix you just pass the array to spawnSync().  But on Windows, this is a very complex problem:
  // - The Win32 CreateProcess() API expects the args to be encoded as a single text string
  // - The decoding of this string is up to the application (not the OS), and there are 3 different
  //   algorithms in common usage:  the cmd.exe shell, the Microsoft CRT library init code, and
  //   the Win32 CommandLineToArgvW()
  // - The encodings are counterintuitive and have lots of special cases
  // - NodeJS spawnSync() tries do the encoding without knowing which decoder will be used
  //
  // See these articles for a full analysis:
  // http://www.windowsinspired.com/understanding-the-command-line-string-and-arguments-received-by-a-windows-program/
  // http://www.windowsinspired.com/how-a-windows-programs-splits-its-command-line-into-individual-arguments/
  private static _buildCommandLineFixup(
    resolvedPath: string,
    args: string[],
    context: IExecutableContext
  ): ICommandLineOptions {
    const fileExtension: string = path.extname(resolvedPath);

    if (OS_PLATFORM === 'win32') {
      // Do we need a custom handler for this file type?
      switch (fileExtension.toUpperCase()) {
        case '.EXE':
        case '.COM':
          // okay to execute directly
          break;
        case '.BAT':
        case '.CMD': {
          Executable._validateArgsForWindowsShell(args);

          // These file types must be invoked via the Windows shell
          let shellPath: string | undefined = context.environmentMap.get('COMSPEC');
          if (!shellPath || !Executable._canExecute(shellPath, context)) {
            shellPath = Executable.tryResolve('cmd.exe');
          }
          if (!shellPath) {
            throw new Error(
              `Unable to execute "${path.basename(resolvedPath)}" ` +
                `because CMD.exe was not found in the PATH`
            );
          }

          const shellArgs: string[] = [];
          // /D: Disable execution of AutoRun commands when starting the new shell context
          shellArgs.push('/d');
          // /S: Disable Cmd.exe's parsing of double-quote characters inside the command-line
          shellArgs.push('/s');
          // /C: Execute the following command and then exit immediately
          shellArgs.push('/c');

          // If the path contains special charactrers (e.g. spaces), escape them so that
          // they don't get interpreted by the shell
          shellArgs.push(Executable._getEscapedForWindowsShell(resolvedPath));
          shellArgs.push(...args);

          return { path: shellPath, args: shellArgs };
        }
        default:
          throw new Error(
            `Cannot execute "${path.basename(resolvedPath)}" because the file type is not supported`
          );
      }
    }

    return {
      path: resolvedPath,
      args: args
    };
  }

  /**
   * Given a filename, this determines the absolute path of the executable file that would
   * be executed by a shell:
   *
   * - If the filename is missing a path, then the shell's default PATH will be searched.
   * - If the filename is missing a file extension, then Windows default file extensions
   *   will be searched.
   *
   * @remarks
   *
   * @param filename - The name of the executable file.  This string must not contain any
   * command-line arguments.  If the name contains any path delimiters, then the shell's
   * default PATH will not be searched.
   * @param options - optional other parameters
   * @returns the absolute path of the executable, or undefined if it was not found
   */
  public static tryResolve(filename: string, options?: IExecutableResolveOptions): string | undefined {
    return Executable._tryResolve(filename, options || {}, Executable._getExecutableContext(options));
  }

  private static _tryResolve(
    filename: string,
    options: IExecutableResolveOptions,
    context: IExecutableContext
  ): string | undefined {
    // NOTE: Since "filename" cannot contain command-line arguments, the "/" here
    // must be interpreted as a path delimiter
    const hasPathSeparators: boolean =
      filename.indexOf('/') >= 0 || (OS_PLATFORM === 'win32' && filename.indexOf('\\') >= 0);

    // Are there any path separators?
    if (hasPathSeparators) {
      // If so, then don't search the PATH.  Just resolve relative to the current working directory
      const resolvedPath: string = path.resolve(context.currentWorkingDirectory, filename);
      return Executable._tryResolveFileExtension(resolvedPath, context);
    } else {
      // Otherwise if it's a bare name, then try everything in the shell PATH
      const pathsToSearch: string[] = Executable._getSearchFolders(context);

      for (const pathToSearch of pathsToSearch) {
        const resolvedPath: string = path.join(pathToSearch, filename);
        const result: string | undefined = Executable._tryResolveFileExtension(resolvedPath, context);
        if (result) {
          return result;
        }
      }

      // No match was found
      return undefined;
    }
  }

  private static _tryResolveFileExtension(
    resolvedPath: string,
    context: IExecutableContext
  ): string | undefined {
    if (Executable._canExecute(resolvedPath, context)) {
      return resolvedPath;
    }

    // Try the default file extensions
    for (const shellExtension of context.windowsExecutableExtensions) {
      const resolvedNameWithExtension: string = resolvedPath + shellExtension;

      if (Executable._canExecute(resolvedNameWithExtension, context)) {
        return resolvedNameWithExtension;
      }
    }

    return undefined;
  }

  private static _buildEnvironmentMap(options: IExecutableResolveOptions): EnvironmentMap {
    const environmentMap: EnvironmentMap = new EnvironmentMap();
    if (options.environment !== undefined && options.environmentMap !== undefined) {
      throw new Error(
        'IExecutableResolveOptions.environment and IExecutableResolveOptions.environmentMap' +
          ' cannot both be specified'
      );
    }
    if (options.environment !== undefined) {
      environmentMap.mergeFromObject(options.environment);
    } else if (options.environmentMap !== undefined) {
      environmentMap.mergeFrom(options.environmentMap);
    } else {
      environmentMap.mergeFromObject(process.env);
    }
    return environmentMap;
  }

  /**
   * This is used when searching the shell PATH for an executable, to determine
   * whether a match should be skipped or not.  If it returns true, this does not
   * guarantee that the file can be successfully executed.
   */
  private static _canExecute(filePath: string, context: IExecutableContext): boolean {
    if (!FileSystem.exists(filePath)) {
      return false;
    }

    if (OS_PLATFORM === 'win32') {
      // NOTE: For Windows, we don't validate that the file extension appears in PATHEXT.
      // That environment variable determines which extensions can be appended if the
      // extension is missing, but it does not affect whether a file may be executed or not.
      // Windows does have a (seldom used) ACL that can be used to deny execution permissions
      // for a file, but NodeJS doesn't expose that API, so we don't bother checking it.

      // However, Windows *does* require that the file has some kind of file extension
      if (path.extname(filePath) === '') {
        return false;
      }
    } else {
      // For Unix, check whether any of the POSIX execute bits are set
      try {
        // eslint-disable-next-line no-bitwise
        if ((FileSystem.getPosixModeBits(filePath) & PosixModeBits.AllExecute) === 0) {
          return false; // not executable
        }
      } catch (error) {
        // If we have trouble accessing the file, ignore the error and consider it "not executable"
        // since that's what a shell would do
      }
    }

    return true;
  }

  /**
   * Returns the list of folders where we will search for an executable,
   * based on the PATH environment variable.
   */
  private static _getSearchFolders(context: IExecutableContext): string[] {
    const pathList: string = context.environmentMap.get('PATH') || '';

    const folders: string[] = [];

    // Avoid processing duplicates
    const seenPaths: Set<string> = new Set<string>();

    // NOTE: Cmd.exe on Windows always searches the current working directory first.
    // PowerShell and Unix shells do NOT do that, because it's a security concern.
    // We follow their behavior.

    for (const splitPath of pathList.split(path.delimiter)) {
      const trimmedPath: string = splitPath.trim();
      if (trimmedPath !== '') {
        if (!seenPaths.has(trimmedPath)) {
          // Fun fact: If you put relative paths in your PATH environment variable,
          // all shells will dynamically match them against the current working directory.
          // This is a terrible design, and in practice nobody does that, but it is supported...
          // so we allow it here.
          const resolvedPath: string = path.resolve(context.currentWorkingDirectory, trimmedPath);

          if (!seenPaths.has(resolvedPath)) {
            if (FileSystem.exists(resolvedPath)) {
              folders.push(resolvedPath);
            }

            seenPaths.add(resolvedPath);
          }

          seenPaths.add(trimmedPath);
        }
      }
    }

    return folders;
  }

  private static _getExecutableContext(options: IExecutableResolveOptions | undefined): IExecutableContext {
    if (!options) {
      options = {};
    }

    const environment: EnvironmentMap = Executable._buildEnvironmentMap(options);

    let currentWorkingDirectory: string;
    if (options.currentWorkingDirectory) {
      currentWorkingDirectory = path.resolve(options.currentWorkingDirectory);
    } else {
      currentWorkingDirectory = process.cwd();
    }

    const windowsExecutableExtensions: string[] = [];

    if (OS_PLATFORM === 'win32') {
      const pathExtVariable: string = environment.get('PATHEXT') || '';
      for (const splitValue of pathExtVariable.split(';')) {
        const trimmed: string = splitValue.trim().toLowerCase();
        // Ignore malformed extensions
        if (/^\.[a-z0-9\.]*[a-z0-9]$/i.test(trimmed)) {
          // Don't add the same extension twice
          if (windowsExecutableExtensions.indexOf(trimmed) < 0) {
            windowsExecutableExtensions.push(trimmed);
          }
        }
      }
    }

    return {
      environmentMap: environment,
      currentWorkingDirectory,
      windowsExecutableExtensions
    };
  }

  /**
   * Given an input string containing special symbol characters, this inserts the "^" escape
   * character to ensure the symbols are interpreted literally by the Windows shell.
   */
  private static _getEscapedForWindowsShell(text: string): string {
    const escapableCharRegExp: RegExp = /[%\^&|<> ]/g;
    return text.replace(escapableCharRegExp, (value) => '^' + value);
  }

  /**
   * Checks for characters that are unsafe to pass to a Windows batch file
   * due to the way that cmd.exe implements escaping.
   */
  private static _validateArgsForWindowsShell(args: string[]): void {
    const specialCharRegExp: RegExp = /[%\^&|<>\r\n]/g;

    for (const arg of args) {
      const match: RegExpMatchArray | null = arg.match(specialCharRegExp);
      if (match) {
        // NOTE: It is possible to escape some of these characters by prefixing them
        // with a caret (^), which allows these characters to be successfully passed
        // through to the batch file %1 variables.  But they will be expanded again
        // whenever they are used.  For example, NPM's binary wrapper batch files
        // use "%*" to pass their arguments to Node.exe, which causes them to be expanded
        // again.  Unfortunately the Cmd.exe batch language provides native escaping
        // function (that could be used to insert the carets again).
        //
        // We could work around that by adding double carets, but in general there
        // is no way to predict how many times the variable will get expanded.
        // Thus, there is no generally reliable way to pass these characters.
        throw new Error(
          `The command line argument ${JSON.stringify(arg)} contains a` +
            ` special character ${JSON.stringify(match[0])} that cannot be escaped for the Windows shell`
        );
      }
    }
  }
}
