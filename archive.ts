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
}

interface ArchiveFile {
  path: string;
  archivePath: string;
}

interface ArchiveOptions {
  key: string;
  rootDir: string;
  outputFile: string;
  files: (string | ArchiveFile)[];
}

async function archive(dryRun: boolean, options: ArchiveOptions) {
  const { key, rootDir } = options;

  const prefix = `[${key}]` + (dryRun ? ' [dry-run]' : '');

  const manifestFileName = 'manifest.json';
  const manifestFilePath = path.join(rootDir, manifestFileName);
  const manifestString = await fs.promises.readFile(manifestFilePath, 'utf8');
  const manifest: Manifest = JSON.parse(manifestString);
  if (typeof manifest.version !== 'string') {
    throw new Error(`${prefix} unable to parse ${manifestFileName} version`);
  }

  const outputFile = options.outputFile.replaceAll(
    '__VERSION__',
    manifest.version,
  );

  const files = options.files.map((file): ArchiveFile => {
    return typeof file === 'string'
      ? { path: path.join(rootDir, file), archivePath: file }
      : file;
  });

  const infoList = [
    { key: 'key', value: key },
    { key: 'name', value: manifest.name || '?' },
    { key: 'directory', value: rootDir },
    { key: 'version', value: manifest.version },
    { key: 'output file', value: outputFile },
    {
      key: `files (${files.length})`,
      value: files.map((file) => file.path).join(' '),
    },
  ];

  let pad = 0;
  for (const info of infoList) {
    pad = Math.max(info.key.length, pad);
  }

  console.log('%s theme info:', prefix);
  for (const info of infoList) {
    console.log('  %s : %s', info.key.padEnd(pad, ' '), info.value);
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

  const promise = new Promise<void>((resolve, reject) => {
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
    const entryInfo = [];
    if (entry.stats) {
      entryInfo.push(entry.stats.size.toLocaleString() + ' B');
    }
    if (entry.sourcePath && entry.sourcePath !== entry.name) {
      entryInfo.push(`source: ${entry.sourcePath}`);
    }

    const entryLabel = entryInfo.length > 0 ? ` (${entryInfo.join(', ')})` : '';

    const nth = entry.index != null ? (entry.index + 1).toString() : '?';

    console.log(
      '  [%s] %s: %s%s',
      nth.padStart(files.length.toString().length, ' '),
      entry.type || 'entry',
      entry.name,
      entryLabel,
    );
  });

  archive.pipe(outputStream);

  console.log('%s creating zip archive: %s', prefix, outputFile);

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    archive.file(file.path, { index, name: file.archivePath });
  }

  await archive.finalize();
  await promise;
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

  const licenseFile: ArchiveFile = { path: 'LICENSE', archivePath: 'LICENSE' };
  const chrome: ArchiveOptions = {
    key: 'chrome',
    rootDir: 'chrome/quite-black',
    outputFile: 'dist/chrome-quite-black-__VERSION__.zip',
    files: [licenseFile, 'manifest.json'],
  };
  const chrome2: ArchiveOptions = {
    key: 'chrome2',
    rootDir: 'chrome/actually-quite-black',
    outputFile: 'dist/chrome-actually-quite-black-__VERSION__.zip',
    files: [licenseFile, 'manifest.json', 'images/theme_toolbar.png'],
  };
  const firefox: ArchiveOptions = {
    key: 'firefox',
    rootDir: 'firefox',
    outputFile: 'dist/firefox-quite-black-__VERSION__.xpi',
    files: [licenseFile, 'manifest.json'],
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
