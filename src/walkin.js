// Why a code or email didn't check in (lookup_not_on_roster), worded for the
// desk, and whether "Accept walk-in" applies (accept_walk_in: a waitlisted
// hacker, or one marked a no-show, if there's an open spot). Online only.

function time(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * { band, card, line, walkIn } for a lookup answer.
 *   band   the card's band title
 *   card   "warning" (amber: there's something to do) or "error" (red)
 *   line   the meta line under the name
 *   walkIn true when Accept walk-in is offered
 */
export function describeLookup(info, eventCode) {
  const r = info?.reason;
  const hacker = !info?.applicant_type || info.applicant_type === "hacker";
  switch (r) {
    case "waitlisted": {
      const detail = info.offered_at
        ? `offered a spot ${time(info.offered_at)}`
        : info.opted_in
          ? "asked for a spot"
          : "didn't ask for a spot";
      return { band: "Waitlisted", card: "warning", line: detail, walkIn: hacker };
    }
    case "no_show":
      return { band: "Marked no-show", card: "warning", line: "missed the cutoff", walkIn: hacker };
    case "rejected":
      return { band: "Not accepted", card: "error", line: "application wasn't accepted", walkIn: false };
    case "not_decided":
      return { band: "Not on roster", card: "error", line: "applied · no decision yet", walkIn: false };
    case "not_submitted":
      return { band: "Not on roster", card: "error", line: "application not submitted", walkIn: false };
    case "wrong_event":
      return { band: "Other event", card: "error", line: info.event_name ? `for ${info.event_name}` : "for another event", walkIn: false };
    case "never_applied":
      return { band: "Not on roster", card: "error", line: `never applied to ${eventCode || "this event"}`, walkIn: false };
    case "already_checked_in":
      return { band: "Already in", card: "warning", line: "already checked in", walkIn: false };
    case "on_roster":
      return { band: "On roster", card: "warning", line: "on the roster now · scan again", walkIn: false };
    default:
      return { band: "Not on roster", card: "error", line: `not on the ${eventCode || ""} roster`.replace(/\s+roster/, " roster"), walkIn: false };
  }
}

/** What accept_walk_in's answer means at the desk. */
export function walkInOutcome(data) {
  switch (data?.status) {
    case "accepted":
    case "readmitted":
    case "already_accepted":
      return { ok: true };
    case "full":
      return { ok: false, title: "No open spots", line: "hacker capacity is full · try again after no-shows are marked" };
    case "not_eligible":
      return { ok: false, title: "Can't accept", line: `application is ${data.application_status || "not eligible"}` };
    default:
      return { ok: false, title: "Walk-in failed", line: JSON.stringify(data) };
  }
}
