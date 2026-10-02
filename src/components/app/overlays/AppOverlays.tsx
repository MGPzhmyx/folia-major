import React from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import SearchWorkspace from '../search/SearchWorkspace';
// Both are opt-in debug surfaces (never shown in a normal session), but sonnetDebug pulls in
// the sonnet variant tables and pretext's layout tables - keep them out of the boot chain.
const DevDebugOverlay = React.lazy(() => import('../../DevDebugOverlay'));
const MemoryMonitorWindow = React.lazy(() => import('../../debug/MemoryMonitorWindow'));
import NowPlayingToast from './NowPlayingToast';
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    const isCurrentSongPosterVisible = useLatticeControlsStore(state => state.isCurrentSongPosterVisible);
    const {
        searchOverlay,
        debugOverlay,
        memoryMonitor,
        floatingControls,
        nowPlayingToast,
    } = model;

    return (
        <>
            {searchOverlay && <SearchWorkspace {...searchOverlay} />}

            {debugOverlay && (
                <React.Suspense fallback={null}>
                    <DevDebugOverlay {...debugOverlay} />
                </React.Suspense>
            )}

            {memoryMonitor && (
                <React.Suspense fallback={null}>
                    <MemoryMonitorWindow {...memoryMonitor} />
                </React.Suspense>
            )}

            {floatingControls
                && (floatingControls.currentView !== 'lattice' || !isCurrentSongPosterVisible)
                && <FloatingPlayerControls {...floatingControls} />}

            {nowPlayingToast && <NowPlayingToast {...nowPlayingToast} />}
        </>
    );
};

export default React.memo(AppOverlays);
