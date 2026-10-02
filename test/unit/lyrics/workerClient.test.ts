import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/lyrics/workerClient.test.ts

describe('lyrics worker client', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('does not post provider callbacks or song identity to the parser worker', async () => {
        const messages: Array<Record<string, unknown>> = [];

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>) {
                messages.push(message);
                structuredClone(message);
                this.onmessage?.({
                    data: {
                        type: 'result',
                        data: { lines: [] },
                        requestId: message.requestId,
                    },
                } as MessageEvent);
            }
        }

        vi.stubGlobal('Worker', FakeWorker);
        const { parseLyricsAsync } = await import('@/utils/lyrics/workerClient');
        const fetchChorusRanges = vi.fn(async () => []);

        await expect(parseLyricsAsync('lrc', '[00:00.00]Line', '', {
            includeInterludes: false,
            filterPattern: '^metadata$',
            songId: 123,
            fetchChorusRanges,
        }, '[00:00.00]Roma')).resolves.toEqual({ lines: [] });

        expect(messages[0]?.options).toEqual({
            includeInterludes: false,
            filterPattern: '^metadata$',
        });
        expect(messages[0]?.romanization).toBe('[00:00.00]Roma');
        expect(fetchChorusRanges).not.toHaveBeenCalled();
    });

    // A worker that fails to load or dies mid-run never posts a reply of its own, so without an
    // error handler every pending Promise hangs forever and workerCallbacks only grows. See
    // failPendingRequests in src/utils/lyrics/workerClient.ts.

    it('resolves pending parses with null when the worker reports an error', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const instances: ErroringFakeWorker[] = [];

        class ErroringFakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: { message?: string }) => void) | null = null;
            onmessageerror: (() => void) | null = null;
            terminated = false;

            constructor() {
                instances.push(this);
            }

            // Never replies: a dying worker has no answer to give.
            postMessage() { }

            terminate() {
                this.terminated = true;
            }
        }

        vi.stubGlobal('Worker', ErroringFakeWorker);
        const { parseLyricsAsync } = await import('@/utils/lyrics/workerClient');

        const pending = parseLyricsAsync('lrc', '[00:00.00]Line', '');
        expect(instances).toHaveLength(1);
        expect(instances[0].onerror).toBeTypeOf('function');

        instances[0].onerror?.({ message: 'worker crashed' });
        await expect(pending).resolves.toBeNull();
        expect(instances[0].terminated).toBe(true);

        // The dead worker is dropped, not reused: the next request builds a fresh one.
        const next = parseLyricsAsync('lrc', '[00:00.00]Line', '');
        expect(instances).toHaveLength(2);
        instances[1].onerror?.({ message: 'crashed again' });
        await expect(next).resolves.toBeNull();
    });

    it('resolves null when the worker cannot be constructed at all', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('Worker', class {
            constructor() {
                throw new Error('blocked by CSP');
            }
        });
        const { parseLyricsAsync } = await import('@/utils/lyrics/workerClient');

        await expect(parseLyricsAsync('lrc', '[00:00.00]Line', '')).resolves.toBeNull();
    });
});
