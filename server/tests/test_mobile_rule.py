"""A CRM mobile number is ten digits, any digits; the lead import follows the duplicate setting."""
import pytest

from app.schemas import crm as S


@pytest.mark.parametrize("value", ["5555555555", "+91 98765 43210", "09876543210", "919876543210", "+1 4155552671"])
def test_valid_numbers(value):
    assert S.CustomerIn(name="A", mobile=value).mobile == value
    assert S.LeadIn(name="A", mobile=value, whatsapp=value).whatsapp == value


@pytest.mark.parametrize("value", ["555555555", "98765", "55555555555555", "abc1234567"])
def test_invalid_numbers(value):
    with pytest.raises(ValueError):
        S.CustomerIn(name="A", mobile=value)
    with pytest.raises(ValueError):
        S.LeadIn(name="A", mobile=value)
    with pytest.raises(ValueError):
        S.LeadIn(name="A", mobile="9876543210", whatsapp=value)
