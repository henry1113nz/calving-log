# Supervised field-testing plan

## Purpose

The first deployment is a usability trial, not a production milk-release system. The goal is
to learn whether a farm worker can understand the navigation, record a normal event and
correctly explain a milk-hold result without coaching.

## Safety and privacy

- Use demonstration cow tags and scenarios only.
- Keep the existing farm process, label and veterinary advice as the authority.
- Do not ask for the participant's age, contact details or other personal information.
- Do not enter a farm owner's identity or real clinical details in the feedback comments.
- Stop the task if the participant starts treating the prototype as a real release decision.

## 15-minute session

1. Say: “This is a student prototype. Please think aloud. I am testing the screen, not you.”
2. Give the participant these tasks one at a time without showing where to click:
   - find all cows whose milk is excluded today;
   - record a demonstration treatment;
   - explain **Hold through**, **Eligible from**, **Predicted**, and **Unknown**;
   - find why an unresolved dry-cow event is in Reviews;
   - schedule a future change from TAD to OAD;
   - optionally review one dry-off decision using SCC evidence.
3. Observe task completion, wrong turns and questions. Do not teach until the person is stuck.
4. Open **Feedback**, record one response for each task, and ask one final question:
   “What is the first thing you would change?”
5. As Owner, review the response summary and turn repeated problems into next-week UI issues.

## Success measures for the first round

- At least three farm participants complete the walkthrough.
- At least 80% can find today's held cows without help.
- Nobody interprets an unknown date as safe.
- Average ease rating is at least 4/5.
- Every repeated usability problem is linked to a specific page and task.

## Evidence to bring to the supervisor

Show the deployed URL, the persistent volume, `/api/health`, one backup file, role-specific
permissions, a submitted feedback response, the Owner-only results summary and the resulting
prioritised UI changes. Use screenshots or anonymised counts; do not show participant or farm
identifiers.
