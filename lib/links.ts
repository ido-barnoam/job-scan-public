// Shared by the scan, the email and the report page.

// LinkedIn shows logged-out visitors a sign-in or "no longer accepting applications" page,
// so what the app reads there can't tell an open job from a closed one.
export function isLinkedIn(url: string): boolean {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
