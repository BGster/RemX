"""Setup for pm package."""
from setuptools import setup, find_packages

setup(
    name="remx",
    version="0.1.0",
    packages=find_packages(where="."),
    package_dir={"": "."},
)
