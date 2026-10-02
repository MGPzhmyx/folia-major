import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/utils/localMetadataWorkerClient.test.ts
// The metadata worker must never leave a parse pending: a worker that fails to load or dies
// mid-run cannot post its own reply, so both entry points resolve null instead of hanging
// (see failPendingRequests in src/utils/localMetadataWorkerClient.ts).

describe('local metadata worker client', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
        vi.restoreAllMocks();
    });

    class ErroringFakeWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: { message?: string }) => void) | null = null;
        onmessageerror: (() => void) | null = null;
        terminated = false;

        constructor(public instances: ErroringFakeWorker[]) {
            instances.push(this);
        }

        // Never replies: a dying worker has no answer to give.
        postMessage() { }

        terminate() {
            this.terminated = true;
        }
    }

    it('resolves pending metadata and cover-hash requests with null when the worker errors', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const instances: ErroringFakeWorker[] = [];
        vi.stubGlobal('Worker', class extends ErroringFakeWorker {
            constructor() {
                super(instances);
            }
        });
        const { hashLocalCoverBlobAsync, parseEmbeddedMetadataAsync } = await import('@/utils/localMetadataWorkerClient');

        const pendingParse = parseEmbeddedMetadataAsync(new File(['x'], 'song.mp3'), true);
        const pendingHash = hashLocalCoverBlobAsync(new Blob(['cover'], { type: 'image/png' }));
        expect(instances).toHaveLength(1);
        expect(instances[0].onerror).toBeTypeOf('function');

        instances[0].onerror?.({ message: 'worker crashed' });
        await expect(pendingParse).resolves.toBeNull();
        await expect(pendingHash).resolves.toBeNull();
        expect(instances[0].terminated).toBe(true);

        // The dead worker is dropped, not reused: the next request builds a fresh one.
        const next = parseEmbeddedMetadataAsync(new File(['x'], 'song.mp3'));
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
        const { parseEmbeddedMetadataAsync } = await import('@/utils/localMetadataWorkerClient');

        await expect(parseEmbeddedMetadataAsync(new File(['x'], 'song.mp3'))).resolves.toBeNull();
    });
});
