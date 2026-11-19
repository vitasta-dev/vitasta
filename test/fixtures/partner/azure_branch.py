import os

API_TYPE = os.environ.get("API_TYPE", "azure")

if API_TYPE == "azure":
    MODEL = "Cohere-command-r-08-2024"
