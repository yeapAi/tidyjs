import * as path from 'path';
import { createTwoFilesPatch } from 'diff';

import type { CliArguments } from './args';
import type { FileReport } from './runner';

export interface OutputStreams {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

export interface RunSummary {
    total: number;
    changed: number;
    unchanged: number;
    skipped: number;
    errors: number;
}

export class Reporter {
    readonly summary: RunSummary = { total: 0, changed: 0, unchanged: 0, skipped: 0, errors: 0 };

    constructor(
        private readonly args: CliArguments,
        private readonly cwd: string,
        private readonly output: OutputStreams
    ) {}

    display(filePath: string): string {
        const relative = path.relative(this.cwd, filePath);
        return (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? filePath : relative).split(path.sep).join('/');
    }

    warning(message: string): void {
        if (!this.args.quiet) {
            this.output.stderr(`warning  ${message}\n`);
        }
    }

    error(message: string): void {
        this.output.stderr(`error  ${message}\n`);
    }

    file(report: FileReport): void {
        this.summary.total++;
        const name = this.display(report.filePath);

        for (const warning of report.warnings) {
            this.warning(`${name}  ${warning}`);
        }

        switch (report.status) {
            case 'error':
                this.summary.errors++;
                this.error(`${name}  ${report.errorStage}: ${report.message}`);
                break;
            case 'changed':
                this.summary.changed++;
                if (!this.args.quiet) {
                    this.output.stdout(`${report.written ? 'formatted' : 'would format'}  ${name}\n`);
                }
                break;
            case 'skipped':
                this.summary.skipped++;
                if (this.args.verbose) {
                    this.output.stdout(`skipped  ${name}  (${report.reason})\n`);
                }
                break;
            default:
                this.summary.unchanged++;
                if (this.args.verbose) {
                    this.output.stdout(`unchanged  ${name}\n`);
                }
                break;
        }

        if (this.args.verbose && report.status !== 'skipped') {
            if (report.configPath) {
                this.output.stdout(`    config: ${this.display(report.configPath)}\n`);
            }
            for (const source of report.sources) {
                const details = [source.detail, source.location ? this.display(source.location) : undefined].filter(Boolean).join(', ');
                this.output.stdout(`    ${source.source}: ${source.status}${details ? ` (${details})` : ''}, ${source.count} diagnostic(s)\n`);
            }
            if (report.status === 'changed' && report.removedUnused.length > 0) {
                this.output.stdout(`    unused names: ${report.removedUnused.join(', ')}\n`);
            }
            if (report.status === 'changed' && report.removedMissing.length > 0) {
                this.output.stdout(`    missing modules: ${report.removedMissing.join(', ')}\n`);
            }
        }

        if (this.args.diff && report.status === 'changed' && report.original !== undefined && report.formatted !== undefined) {
            this.output.stdout(createTwoFilesPatch(name, name, report.original, report.formatted, undefined, undefined, { context: 3 }));
        }
    }

    finish(): void {
        if (this.args.quiet && this.summary.errors === 0) {
            return;
        }
        const { total, changed, unchanged, skipped, errors } = this.summary;
        const changedLabel = this.args.mode === 'write' ? 'formatted' : 'to format';
        this.output.stderr(`${total} file(s): ${changed} ${changedLabel}, ${unchanged} unchanged, ${skipped} skipped, ${errors} error(s)\n`);
        if (this.args.mode === 'list' && changed > 0) {
            this.output.stderr('Run again with --write to apply the changes.\n');
        }
    }
}
