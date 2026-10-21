/**
 * The confidence cut-offs `decideVoice` applies to engine answers. They are tuned against one pinned
 * Jev version (spec 2026-10-21-voice-mode, "How it decides"); no other file holds a threshold.
 */

/** `is_command` noul below this reads as chatter. */
export const IS_COMMAND_MIN = 0.5;
/** The `action` choice below this confidence is not acted on. */
export const ACTION_MIN = 0.55;
/** A confirm or cancel needs this much confidence, since it sends or drops a proposal. */
export const CONFIRM_MIN = 0.7;
/** The `status` choice below this confidence comes with alternatives. */
export const OPEN_STATUS_SURE = 0.6;
/** A card option is taken when its probability is at least this; otherwise the words go to Other. */
export const ANSWER_OPTION_MIN = 0.5;
/** A multi-select option is taken when its noul is at least this. */
export const OPTION_SELECTED_MIN = 0.5;
