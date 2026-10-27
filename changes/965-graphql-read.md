Fixed

A GraphQL read that has the word `mutation` only inside a string or a `#` comment is no longer refused as a release; a real mutation, a document the guard cannot read, and any `$` are still refused (#965).
