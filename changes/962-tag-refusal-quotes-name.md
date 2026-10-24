Fixed

A tag refusal no longer repeats a tag name with a shell character in it as it is. `git tag v1$(id)` now refuses as `creating the tag 'v1$(id)'`, so a person who copies the line into a shell runs nothing; a plain name like `v1.2.0` prints as it did. The same guard covers the `git tag` and `git update-ref` ways of naming the tag. (#962)
