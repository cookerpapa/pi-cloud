# ADR-0182: Complete commentary, streaming final answers

Status: accepted, 2026-09-21.

Keep the Agent Loop and Kafka/PG authority model unchanged. Use explicit provider
message phase for presentation, never infer it from prose or a future Tool call.
GPT Responses provides stable commentary/final_answer on output-item creation.
The real DeepSeek Pro route initially marked a Tool preamble final_answer and
changed it to commentary at completion; preserve its current streaming behavior
until it has a reliable early contract. Do not rewrite provider history phases.

The existing Worker-local Responses observer records phase metadata by response
and text-item ordinal, before forwarding the original bytes to Pi. A lease-local
resolver supplies that metadata to the Runner through its existing runtime
adapter. It does not parse text, call PG or allocate another transport. Pin tests
to Pi's public text_start ordering, including interleaved reasoning/Tools/search.

For a known commentary block, suppress its deltas and publish its complete text
at text_end. A known final_answer streams normally; unclassified routes retain
their normal stream. Add optional phase to public text spans/query projections;
commentary is never animated or merged with a later final answer. Complete
commentary still goes through Kafka before display and belongs to interrupted
visible-prefix recovery if its full native Assistant has not committed yet.
Unfinished, never-displayed commentary need not be recovered as visible text.

Original Pi message contents, signatures, phase replay, sampling/Tool boundaries,
seals and UNKNOWN stay unchanged. No per-token PG writes or extra durability ACK.
Deploy matching Worker/Projector/Web after draining; no database migration or
Cube template change is required. Historical phase-absent text remains valid
because phase is genuinely optional provider metadata, not a second decoder.

Reference: [OpenAI assistant phase guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5#phase-parameter).
Pi 0.84.1's public subscribe/text_start/text_end contract is tested with its real
Responses adapter; early phase is not inferred from Pi's provisional stopReason.
