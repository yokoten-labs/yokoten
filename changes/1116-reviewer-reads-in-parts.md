Fixed

The reviewer no longer fails a pull request because of length (#1116). A diff over 120,000 characters is reviewed in up to four parts, one model call each, instead of being refused; any part that asks for changes asks for all, and a part with no clear answer posts a comment, never an approval. Like Gemini's review, it says less at the source: a summary of 2 or 3 sentences, each problem once, and a severity on every finding; a low finding never blocks a merge. A summary or finding that still runs long is cut, the low ones first, instead of failing the review.
