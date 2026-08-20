/**
 * Matches an event name against configured groups.
 * Returns all groups that have a matching substring (case-insensitive).
 */
export function matchEvent(eventName, groups) {
  const matchedGroups = [];
  const normalizedEventName = eventName.toLowerCase();

  for (const group of groups) {
    for (const matchStr of group.matches) {
      if (normalizedEventName.includes(matchStr.toLowerCase())) {
        matchedGroups.push(group);
        break; // Match found for this group, move to next group
      }
    }
  }

  return matchedGroups;
}