/** Demo tasks the server starts with, so the web client has something to show. Ids come from the old import. */
export function seedTasks(now = new Date()) {
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetDays, hour) => {
    const d = new Date(now.getTime() + offsetDays * day);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { id: "3", userId: "dana", title: "Send the Q4 roadmap to Lior", due: at(-1, 9), priority: "high" },
    { id: "5", userId: "dana", title: "Review the onboarding copy", due: at(0, 14), priority: "medium" },
    { id: "8", userId: "dana", title: "Book the team offsite room", due: at(2, 10), priority: "low" },
    { id: "12", userId: "omer", title: "Fix the flaky export job", due: at(0, 11), priority: "high" },
  ];
}
