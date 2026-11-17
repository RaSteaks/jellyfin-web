import Hls, { Events, type FragLoadedData } from 'hls.js/dist/hls.js';

export interface DiscBufferStatus {
    waiting: boolean;
    bufferedSeconds: number;
    targetSeconds: number;
}

/** Budgets describe encoded media; a complete fragment and decoder memory are additional. */
export function getDiscBufferLimits(bitrate: number, mobile: boolean, restrictedHighBitrate: boolean) {
    const bytes = (mobile ? 48 : 96) * 1024 * 1024;
    const forward = Math.min(
        bitrate > 0 ? bytes * 0.8 * 8 / bitrate : 30,
        restrictedHighBitrate && bitrate >= 25_000_000 ? 6 : 60
    );
    const back = Math.min(15, bitrate > 0 ? bytes * 0.2 * 8 / bitrate : 15);
    return { forward, back, start: Math.min(6, forward / 2), resume: Math.min(10, forward * 0.75) };
}

/** Only the range containing the playhead is usable; a later range may follow a seek hole. */
export function getDiscBufferedAhead(ranges: TimeRanges, position: number) {
    for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= position && ranges.end(i) > position) {
            return ranges.end(i) - position;
        }
    }
    return 0;
}

/** Hysteresis around hls.js's existing bandwidth estimator and emergency downswitch. */
export class DiscAdaptivePolicy {
    cap = 0;
    private lastLevel = -1;
    private lastTick = 0;
    private wasPlaying = false;
    private stableMs = 0;
    private readonly headroomMs: number[];
    private raisedAt = -Infinity;
    private cooldownUntil = 0;

    constructor(private readonly bitrates: number[], bandwidth: number) {
        this.cap = this.safeLevel(bandwidth);
        this.headroomMs = bitrates.map(() => 0);
    }

    private safeLevel(bandwidth: number) {
        let result = 0;
        this.bitrates.forEach((bitrate, index) => {
            if (bitrate <= bandwidth * 0.7) result = index;
        });
        return result;
    }

    resetStability() {
        this.stableMs = 0;
        this.headroomMs.fill(0);
        this.wasPlaying = false;
    }

    stalled(now: number, level: number) {
        this.resetStability();
        if (now - this.raisedAt < 30_000) {
            this.cooldownUntil = now + 240_000;
            this.raisedAt = -Infinity;
        }
        this.cap = Math.max(0, Math.min(this.cap, level - 1));
        return this.cap;
    }

    update(now: number, level: number, bandwidth: number, buffered: number, target: number, playing: boolean) {
        const elapsed = playing && this.wasPlaying ? now - this.lastTick : 0;
        this.stableMs += elapsed;
        this.bitrates.forEach((bitrate, index) => {
            if (bandwidth * 0.7 >= bitrate && buffered >= target * 0.75) this.headroomMs[index] += elapsed;
            else this.headroomMs[index] = 0;
        });
        this.lastTick = now;
        this.wasPlaying = playing;
        if (level < 0) return this.cap;

        if (this.lastLevel >= 0 && level < this.lastLevel) {
            this.resetStability();
            this.cap = Math.min(this.cap, level);
            if (now - this.raisedAt < 30_000) this.cooldownUntil = now + 240_000;
        }
        this.lastLevel = level;

        const safeLevel = this.safeLevel(bandwidth);
        if (playing && buffered < Math.min(5, target / 4) && safeLevel < level) {
            this.cap = safeLevel;
            this.resetStability();
        } else if (playing && level === this.cap && this.cap < this.bitrates.length - 1
            && this.stableMs >= 120_000 && this.headroomMs[this.cap + 1] >= 120_000 && now >= this.cooldownUntil && now - this.raisedAt >= 30_000
            && buffered >= target * 0.75 && safeLevel > this.cap) {
            this.cap++;
            this.raisedAt = now;
        }
        return this.cap;
    }
}

interface DiscPlaybackOptions {
    mobile: boolean;
    restrictedHighBitrate: boolean;
    duration: number;
    initialBandwidth?: number;
    onStatus: (status: DiscBufferStatus) => void;
    onError: (error: unknown) => void;
}

/** One controller per HLS instance; destroying the source also cancels every buffer wait. */
export class DiscPlaybackController {
    private policy?: DiscAdaptivePolicy;
    private timer: ReturnType<typeof setInterval>;
    private initialized = false;
    private seekRecovery = false;
    private userPaused = false;
    private holding: 'start' | 'resume' | null = null;
    private holdStarted = 0;
    private observedBitrates: number[] = [];
    private lastObservedLevel = -1;

    constructor(private readonly hls: Hls, private readonly media: HTMLVideoElement, private readonly options: DiscPlaybackOptions) {
        hls.on(Events.MANIFEST_PARSED, this.onManifest);
        hls.on(Events.FRAG_LOADED, this.onFragment);
        media.addEventListener('playing', this.onPlaying);
        media.addEventListener('waiting', this.onWaiting);
        media.addEventListener('seeking', this.onSeeking);
        this.timer = setInterval(this.update, 250);
    }

    get isHolding() { return this.holding !== null; }

    private onManifest = () => {
        const bandwidth = this.options.initialBandwidth || this.hls.bandwidthEstimate;
        if (this.hls.levels.length > 1) {
            this.policy = new DiscAdaptivePolicy(this.hls.levels.map(level => level.bitrate), bandwidth);
            this.hls.autoLevelCapping = this.policy.cap;
            this.hls.startLevel = this.policy.cap;
            if (bandwidth > 0) this.hls.bandwidthEstimate = bandwidth;
        }
    };

    private onFragment = (_event: Events.FRAG_LOADED, data: FragLoadedData) => {
        const frag = data.frag;
        if (frag.type !== 'main' || typeof frag.sn !== 'number' || frag.stats.aborted) return;
        if (frag.level !== this.lastObservedLevel) this.observedBitrates = [];
        this.lastObservedLevel = frag.level;
        this.observedBitrates.push(frag.stats.loaded * 8 / frag.duration);
        this.observedBitrates = this.observedBitrates.slice(-5);
        this.update();
    };

    private limits() {
        const level = this.hls.levels[this.hls.currentLevel >= 0 ? this.hls.currentLevel : this.hls.startLevel];
        const bitrate = Math.max(level?.bitrate || 0, ...this.observedBitrates);
        return getDiscBufferLimits(bitrate, this.options.mobile, this.options.restrictedHighBitrate);
    }

    private onPlaying = () => {
        if (this.userPaused) return;
        if (!this.initialized || this.seekRecovery) {
            this.initialized = true;
            this.seekRecovery = false;
            if (getDiscBufferedAhead(this.media.buffered, this.media.currentTime) < this.limits().start) {
                // Let the first playing event establish the existing OSD/session, then
                // hold the first frame. This preserves autoplay permission and cancellation.
                this.hold('start');
            }
        }
    };

    private onWaiting = () => {
        if (!this.initialized || this.userPaused || this.seekRecovery || this.media.seeking || this.isHolding) return;
        if (this.policy) this.hls.autoLevelCapping = this.policy.stalled(performance.now(), this.hls.currentLevel);
        this.hold('resume');
    };

    private onSeeking = () => {
        const resumeAfterSeek = this.isHolding && !this.userPaused;
        this.policy?.resetStability();
        this.seekRecovery = true;
        this.holding = null;
        this.observedBitrates = [];
        this.options.onStatus({ waiting: false, bufferedSeconds: 0, targetSeconds: 0 });
        if (resumeAfterSeek) void this.media.play().catch(this.options.onError);
    };

    private hold(kind: 'start' | 'resume') {
        this.holding = kind;
        this.holdStarted = performance.now();
        this.media.pause();
        this.update();
    }

    private update = () => {
        const limits = this.limits();
        this.hls.config.maxBufferLength = limits.forward;
        this.hls.config.maxMaxBufferLength = limits.forward;
        this.hls.config.backBufferLength = limits.back;
        this.hls.config.maxBufferSize = Math.floor((this.options.mobile ? 48 : 96) * 1024 * 1024 * 0.8);
        const buffered = getDiscBufferedAhead(this.media.buffered, this.media.currentTime);
        const now = performance.now();
        if (this.policy) {
            this.hls.autoLevelCapping = this.policy.update(now, this.hls.currentLevel, this.hls.bandwidthEstimate,
                buffered, limits.forward, !this.media.paused && !this.media.seeking && this.media.readyState >= 3);
        }
        if (!this.holding) return;
        const remaining = Math.max(0, this.options.duration - this.media.currentTime);
        const target = Math.min(this.holding === 'start' ? limits.start : limits.resume, remaining);
        this.options.onStatus({ waiting: true, bufferedSeconds: buffered, targetSeconds: target });
        if (buffered >= target || (now - this.holdStarted >= 15_000 && this.media.readyState >= 3)) this.playNow();
    };

    pauseForUser() {
        this.userPaused = true;
        this.holding = null;
        this.policy?.resetStability();
        this.options.onStatus({ waiting: false, bufferedSeconds: 0, targetSeconds: 0 });
        this.media.pause();
    }

    playNow() {
        this.userPaused = false;
        this.holding = null;
        this.seekRecovery = false;
        this.options.onStatus({ waiting: false, bufferedSeconds: 0, targetSeconds: 0 });
        void this.media.play().catch(this.options.onError);
    }

    destroy() {
        clearInterval(this.timer);
        this.hls.off(Events.MANIFEST_PARSED, this.onManifest);
        this.hls.off(Events.FRAG_LOADED, this.onFragment);
        this.media.removeEventListener('playing', this.onPlaying);
        this.media.removeEventListener('waiting', this.onWaiting);
        this.media.removeEventListener('seeking', this.onSeeking);
        this.options.onStatus({ waiting: false, bufferedSeconds: 0, targetSeconds: 0 });
    }
}
