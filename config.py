# config.py
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    api_key: str
    model_config = {"env_file": ".env"}

settings = Settings()
# use settings.api_key anywhere