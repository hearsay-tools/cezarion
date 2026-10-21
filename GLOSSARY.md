# Domain glossary

## Turn

One unit of agent work that ends with the runner's turn-end signal. A session
can carry several turns.

## Turn settlement

Cezar's processing of a completed turn to account for input still owed,
questions, waits, completion requests and workflow progression. A transport
acknowledgement can defer settlement until after the turn-end signal.

Turn settlement concerns what happens after agent work. Session termination
and proof that worker resources can be removed remain separate facts.

## Native failure control

A test fixture that selects when a native runner mock fails and how long that
failure remains active. It can hold one failure until release, or keep failing
matching wake prompts until lifted. All matching runs in a test fixture share
that failure state. The state survives mock subprocess restarts and ends with
the fixture; separate fixtures have separate state.

The real runner and its transport remain in use. The mock retains its native
failure response, including an intentional process exit where the test needs
to prove that input was not read.
