import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';

declare module 'archiver' {
  interface EntryData {
    index?: number;
    sourcePath?: string | null;
  }
}

interface Manifest {
  name: string;
  version: string;
  theme?: {
    images?: { [key: string]: string };
  };
}

interface ArchiveFile {
  path: string;
  archivePath: string;
}

interface ArchiveOptions {
  key: string;
  rootDir: string;
  files?: (string | ArchiveFile)[];
  outputFile: string | ((manifest: Manifest) => string);
}

function toArchiveFile(rootDir: string, archivePath: string): ArchiveFile {
  rootDir = path.resolve(rootDir);
  const archiveAbsPath = path.resolve(rootDir, archivePath);

  return {
    path: path.relative(process.cwd(), archiveAbsPath),
    archivePath: path.relative(rootDir, archiveAbsPath),
  };
}

async function archive(dryRun: boolean, options: ArchiveOptions) {
  const { key, rootDir } = options;

  const rootDirStats = await fs.promises.stat(rootDir);
  if (!rootDirStats.isDirectory()) {
    throw new Error(`not a directory: ${rootDir}`);
  }

  const prefix = `[${key}]` + (dryRun ? ' [dry-run]' : '');

  const manifestFile = toArchiveFile(rootDir, 'manifest.json');
  const manifestString = await fs.promises.readFile(manifestFile.path, 'utf8');
  const manifest: Manifest = JSON.parse(manifestString);

  if (typeof manifest.version !== 'string') {
    throw new Error(
      `${prefix} unable to parse ${manifestFile.archivePath} version`,
    );
  }

  const outputFile =
    typeof options.outputFile === 'function'
      ? options.outputFile(manifest)
      : options.outputFile;

  // get unique files to be included in the archive
  const fileMap: { [archivePath: string]: ArchiveFile } = { __proto__: null! };

  function saveFile(file: string | ArchiveFile) {
    const archiveFile =
      typeof file === 'string' ? toArchiveFile(rootDir, file) : file;

    fileMap[archiveFile.archivePath] ||= archiveFile;
  }

  for (const file of options.files || []) {
    saveFile(file);
  }

  saveFile(manifestFile);

  // trust that these are strings
  const themeImages =
    typeof manifest.theme?.images === 'object' &&
    manifest.theme.images !== null &&
    !Array.isArray(manifest.theme.images)
      ? Object.values(manifest.theme.images)
      : [];

  for (const imagePath of themeImages) {
    saveFile(imagePath);
  }

  const files = Object.values(fileMap);
  const filesLengthLength = files.length.toString().length;

  const themeInfo = {
    __proto__: null,
    key,
    name: manifest.name || '?',
    directory: rootDir,
    version: manifest.version,
    'output file': outputFile,
    [`files (${files.length})`]: files.map((file) => file.path).join(' '),
  };

  let pad = 0;
  for (const infoKey in themeInfo) {
    pad = Math.max(infoKey.length, pad);
  }

  console.log('%s theme info:', prefix);
  for (const infoKey in themeInfo) {
    console.log('  %s : %s', infoKey.padEnd(pad, ' '), themeInfo[infoKey]);
  }

  try {
    await fs.promises.stat(outputFile);
    console.log('%s replacing existing output file: %s', prefix, outputFile);
  } catch {}

  let outputStream: Writable;
  if (dryRun) {
    outputStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  } else {
    outputStream = fs.createWriteStream(outputFile).on('end', () => {
      console.log('%s data has been drained', prefix);
    });
  }

  const archive = new ZipArchive();

  const streamClosePromise = new Promise<void>((resolve, reject) => {
    outputStream.on('error', reject);
    outputStream.on('close', () => {
      console.log(
        '%s created: %s (%s B)',
        prefix,
        outputFile,
        archive.pointer().toLocaleString(),
      );

      resolve();
    });

    archive.on('error', reject);
    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') {
        console.warn('%s archive ENOENT:', prefix, error);
      } else {
        reject(error);
      }
    });
  });

  archive.on('entry', (entry) => {
    const nth = entry.index != null ? (entry.index + 1).toString() : '?';
    const nthLabel = nth.padStart(filesLengthLength, ' ');

    const entryInfo: string[] = [];
    if (entry.stats) {
      entryInfo.push(entry.stats.size.toLocaleString() + ' B');
    }
    if (entry.sourcePath && entry.sourcePath !== entry.name) {
      entryInfo.push(`source: ${entry.sourcePath}`);
    }

    const entryLabel = entryInfo.length > 0 ? ` (${entryInfo.join(', ')})` : '';

    console.log(
      '  [%s] %s: %s%s',
      nthLabel,
      entry.type || 'entry',
      entry.name,
      entryLabel,
    );
  });

  console.log('%s creating zip archive: %s', prefix, outputFile);

  archive.pipe(outputStream);

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    archive.file(file.path, { index, name: file.archivePath });
  }

  await archive.finalize();
  await streamClosePromise;
}

function getHelpText() {
  return 'usage: node archive.ts <chrome|chrome2|firefox> [-n|--dry-run]';
}

async function main(): Promise<number | void> {
  const { argv } = process;

  if (argv.length < 3) {
    console.error(getHelpText());
    return 1;
  }

  const licenseFile = toArchiveFile('.', 'LICENSE');
  const chrome: ArchiveOptions = {
    key: 'chrome',
    rootDir: 'chrome/quite-black',
    files: [licenseFile],
    outputFile(manifest) {
      return `dist/chrome-quite-black-${manifest.version}.zip`;
    },
  };
  const chrome2: ArchiveOptions = {
    key: 'chrome2',
    rootDir: 'chrome/actually-quite-black',
    files: [licenseFile],
    outputFile(manifest) {
      return `dist/chrome-actually-quite-black-${manifest.version}.zip`;
    },
  };
  const firefox: ArchiveOptions = {
    key: 'firefox',
    rootDir: 'firefox',
    files: [licenseFile],
    outputFile(manifest) {
      return `dist/firefox-quite-black-${manifest.version}.xpi`;
    },
  };

  const themes = [chrome, chrome2, firefox];
  const keysSet = new Set<string>();
  let dryRun = false;

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];

    switch (arg) {
      case '-h':
      case '--help':
        console.log(getHelpText());
        return;
      case '-n':
      case '--dry-run':
        dryRun = true;
        break;
      case chrome.key:
      case chrome2.key:
      case firefox.key:
        keysSet.add(arg);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (keysSet.size === 0) {
    throw new Error('no themes provided to archive');
  }

  const keys = Array.from(keysSet);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];

    for (const theme of themes) {
      if (theme.key === key) {
        await archive(dryRun, theme);
        break;
      }
    }

    // show separator if not the last argument
    if (index < keys.length - 1) {
      console.log();
    }
  }
}

(async () => {
  try {
    const exitCode = await main();

    if (exitCode != null) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    process.exitCode = 1;

    console.error(
      !Error.isError(error)
        ? error
        : error.name === 'Error'
          ? `error: ${error.message}`
          : error.toString(),
    );
  }
})();
