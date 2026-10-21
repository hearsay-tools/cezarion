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
