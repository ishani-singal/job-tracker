import { Injectable } from '@nestjs/common';

/** Shared global abort signal for every outbound LLM call (ATS scoring, the
 * resu/linkedin agent service, session chat turns). stop() aborts whatever
 * is currently in flight and immediately swaps in a fresh AbortController so
 * calls made after stopping aren't pre-aborted. */
@Injectable()
export class LlmKillSwitchService {
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stop(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }
}
