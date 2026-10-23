# InterviewIQ — Product flow and implementation sequence

## Core user flow (implemented in this starter)

```text
New visitor
  └── Register / Login
        └── Dashboard (real MongoDB counts)
              ├── View previous sessions
              └── New interview
                    └── Select role / type / difficulty / topic / length
                          └── Backend creates first question
                                ├── AI mode: Responses API structured output
                                └── Practice mode: curated question bank
                                      └── Interview room
                                            └── Submit a text answer
                                                  ├── More questions? → next question
                                                  └── Last answer → Feedback generation
                                                        └── Results page + past answers
                                                              └── History and dashboard
```

## Weeks 1–6 implementation progress

- [x] Frontend scaffold with auth, dashboard, interview setup, interview room, history and results routes
- [x] MongoDB User and Interview schemas
- [x] Signup/login/logout with HTTP-only session cookies
- [x] Interview ownership checks
- [x] AI question generation and next-question flow using OpenAI Responses API
- [x] Practice mode for running without a paid API key
- [x] Persisted Q&A turn history, feedback and dashboard summary
- [ ] Automated backend tests and end-to-end tests (next milestone)
- [ ] Validated deployment in your target hosting environment

## Next tasks, in order

1. Install dependencies and run both builds on a development machine.
2. Start MongoDB; test register/login/new interview/answers/feedback/history manually.
3. Add Supertest integration tests with isolated MongoDB test database.
4. Add Playwright smoke test covering complete text workflow.
5. Improve session recovery after failed AI calls and add session expiry/timeout controls.
6. Add transcription endpoint with MIME validation, file size restrictions and explicit mic consent.
7. Add voice output as an option; retain text fallback.
8. Implement historical topic analytics with model/rubric versioning.
9. Add optional resume parsing and user-controlled deletion.
10. Deploy frontend/API under one site behind a secure reverse proxy, configure monitoring and CI.

## Acceptance test: full session

- Register with a new email and 8+-character password.
- From dashboard, choose a Technical, DSA, Intermediate session of 3 questions.
- Answer each question with at least 10 characters; step counter should move 1→2→3.
- Last submission should redirect to Results and display 3 answers.
- In practice mode, the score should say **Not scored**, not a made-up grade.
- History should show the new session and completed status.
- Sign out; attempting to fetch `/api/interviews` should return 401.
- Sign in with a different account; fetching someone else's interview ID should return 404.
- Try submitting two answers to the same step concurrently; only one should be applied.
