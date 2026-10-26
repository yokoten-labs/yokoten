Fixed

The reviewer no longer fails a pull request because of length (#1116). A diff over 120,000 characters is reviewed in up to four parts, one model call each, instead of being refused; any part that asks for changes asks for all, and a part with no clear answer posts a comment, never an approval. A long summary or finding is cut, and findings past ten are counted in one line, instead of failing the review.
