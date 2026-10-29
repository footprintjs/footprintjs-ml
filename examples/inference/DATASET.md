# Digit data attribution

The digit observations in `fixtures/train.json` and `fixtures/validation.json` derive from:

Alpaydin, E. & Kaynak, C. (1998). *Optical Recognition of Handwritten Digits* [Dataset]. UCI Machine Learning Repository. [DOI: 10.24432/C50P49](https://doi.org/10.24432/C50P49).

UCI distributes this dataset under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Its [official dataset page](https://archive.ics.uci.edu/dataset/80/optical+recognition+of+handwritten+digits) identifies the authors, citation and license.

These fixtures use the 1,797-observation dataset bundled by [scikit-learn `load_digits`](https://scikit-learn.org/stable/modules/generated/sklearn.datasets.load_digits.html), which copies the original UCI test set. Each observation has 64 features representing an 8×8 digit image, with intensity values from 0 to 16 and a class from 0 to 9.

Our earlier example reordered and split that subset with a stratified split using `random_state=19` and `test_size=0.25`, yielding 1,347 training rows and 450 validation rows. Numeric arrays were serialized as float64 JSON values. This example copies those derived files unchanged, verifies their recorded hashes, and uses the first 64 validation rows as its fixed inference batch. These are derived partitions of the scikit-learn subset, not UCI's original training/test partition.

The repository's implementation code is MIT licensed. The copied/derived digit observations retain the dataset attribution and CC BY 4.0 terms above. Generated model/scaler parameters and their provenance are described in [the example guide](README.md).
