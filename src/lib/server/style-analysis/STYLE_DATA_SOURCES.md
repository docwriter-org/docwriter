# Style metric data sources

The style analyzer keeps its word data in `style-data.json`. Run `node scripts/build-style-data.mjs` to rebuild the file from the sources below.

The concreteness scores come from the Brysbaert, Warriner, and Kuperman ratings. The downloaded copy is the MIT licensed `StephanAkkerman/concreteness-ratings` dataset on Hugging Face.

The common word list comes from the MIT licensed `first20hours/google-10000-english` repository. The analyzer uses the first 5,000 words.

The idiom list comes from `eubinecto/idiomatch`. Its entries were derived from IBM's SLIDE vocabulary and Wiktionary. The analyzer uses the idiom text only.

The sentiment words and scores come from AFINN 165 through the MIT licensed `afinn-165` package.

The background phrase counts come from the MIT licensed `corpus-brown` package. The build script counts two to four word phrases and keeps the 50,000 most frequent phrases that occur at least twice.
