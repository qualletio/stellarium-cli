import type { DeployStatus, DeploySummary } from '../commands/deploy.js';
import { type RenderContext, type Style, table } from '../output.js';

const labels: Record<DeployStatus, string> = {
    deployed: 'deployed',
    would_deploy: 'would deploy',
    unchanged: 'unchanged',
    skipped: 'skipped',
};

function statusColor(status: string, style: Style): (text: string) => string {
    if (status.startsWith('deployed')) return style.green;
    if (status.startsWith('would')) return style.cyan;
    return style.dim;
}

function counts(summary: DeploySummary): string {
    const parts = Object.entries(labels).flatMap(([status, label]) => {
        const count = summary.items.filter((item) => item.status === status).length;
        return count > 0 ? [`${count} ${label}`] : [];
    });
    if (summary.feeMicroUsd > 0) parts.push(`$${summary.feeMicroUsd / 1_000_000} in deploy fees`);
    return parts.join(', ');
}

export function renderDeploy(summary: DeploySummary, style: Style, context: RenderContext): string {
    if (context.agent) {
        return [...summary.items.map((item) => `${item.status} ${item.kind} ${item.ref} ${item.file}`), `summary: ${counts(summary)}`].join('\n');
    }
    const rows = summary.items.map((item) => [labels[item.status], item.kind, item.ref, item.file]);
    const body = table(['STATUS', 'KIND', 'NAME', 'FILE'], rows, {
        width: context.width,
        style,
        color: (column, text) => (column === 0 ? statusColor(text, style)(text) : text),
    });
    return `${body}\n\n${style.dim(counts(summary))}`;
}
